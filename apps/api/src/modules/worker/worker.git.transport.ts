import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import type { GitTransport } from '#modules/host/git.transport.js';
import { localHost } from '#modules/host/local.execution.host.js';
import type { WorkerConnection } from './worker.connection.js';
import { WorkerExecutionHost } from './worker.execution.host.js';

/** How long one git command on either side may take. A bundle of a large history takes a while to pack. */
const GIT_TIMEOUT_MS = 10 * 60_000;

/** Most bytes of git's output to buffer: `for-each-ref` over a repository with many tags prints a lot. */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * How many recent ref tips each side offers when working out what the other already has. Each one
 * costs a round trip to the worker, and a repository can have thousands; a few dozen always reach
 * back to a commit both sides hold.
 */
const SHARED_TIP_CANDIDATES = 64;

/** Where a ref is moved to on the receiving side, and from where. Only forced refspecs (`+src:dst`) are used. */
interface Refspec {
    src: string;
    dst: string;
}

const parseRefspec = (refspec: string): Refspec => {
    const match = /^\+([^:]+):(.+)$/.exec(refspec);
    if (!match) throw new Error(`only forced refspecs (+src:dst) can move to or from a worker, got "${refspec}"`);
    return { src: match[1]!, dst: match[2]! };
};

/** One side of a transfer: somewhere to run git in a repository, and to move bundle bytes in and out. */
interface Side {
    git(repo: string, args: string[]): Promise<string>;
    readBytes(path: string): Promise<Buffer>;
    writeBytes(path: string, data: Buffer): Promise<void>;
    remove(path: string): Promise<void>;
    /** A folder a bundle can be written to and read from, created if need be. */
    scratch(repo: string): Promise<string>;
    /** Done with a folder `scratch` gave: removed if it was made for this one transfer, kept otherwise. */
    release(dir: string): Promise<void>;
}

/** This machine. */
const local: Side = {
    git: async (repo, args) =>
        (await localHost.exec('git', ['-C', repo, ...args], { cwd: repo, timeoutMs: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER })).stdout,
    readBytes: path => readFile(path),
    writeBytes: (path, data) => writeFile(path, data),
    remove: path => rm(path, { recursive: true, force: true }),
    scratch: () => mkdtemp(join(tmpdir(), 'wilson-bundle-')),
    release: dir => rm(dir, { recursive: true, force: true }),
};

/** The worker, over its connection. Bundles go in the clone's own git folder, inside the project's roots. */
const remote = (connection: WorkerConnection): Side => {
    const host = new WorkerExecutionHost(connection);
    return {
        git: async (repo, args) =>
            (await host.exec('git', ['-C', repo, ...args], { cwd: repo, timeoutMs: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER })).stdout,
        readBytes: async path => Buffer.from(await connection.call({ op: 'readBytes', path }, GIT_TIMEOUT_MS), 'base64'),
        writeBytes: async (path, data) => {
            await connection.call({ op: 'writeBytes', path, data: data.toString('base64') }, GIT_TIMEOUT_MS);
        },
        remove: path => host.removeTree(path),
        scratch: async repo => {
            const gitDir = (await host.exec('git', ['-C', repo, 'rev-parse', '--absolute-git-dir'], { cwd: repo })).stdout.trim();
            const dir = posix.join(gitDir, 'wilson-transfer');
            await host.mkdir(dir);
            return dir;
        },
        // Kept: it lives in the clone's git folder for as long as the clone does, and holds nothing
        // between transfers.
        release: async () => {},
    };
};

/** The most recent ref tips in `repo`, as object ids. */
const recentTips = async (side: Side, repo: string): Promise<string[]> => [
    ...new Set(
        (await side.git(repo, ['for-each-ref', '--sort=-committerdate', `--count=${SHARED_TIP_CANDIDATES}`, '--format=%(objectname)']))
            .split('\n')
            .map(line => line.trim())
            .filter(Boolean),
    ),
];

/** Whether `repo` has commit `sha`. */
const hasCommit = async (side: Side, repo: string, sha: string): Promise<boolean> =>
    side.git(repo, ['cat-file', '-e', `${sha}^{commit}`]).then(
        () => true,
        () => false,
    );

/**
 * The commits a bundle from `from` to `to` can leave out: recent tips on either side that the other
 * side also has. Asked both ways because the two clones rarely match tip for tip. A worker's clone
 * comes from the forge, so it is usually ahead of this machine on some branches and behind on the
 * ones Wilson has merged but not pushed; tips only one side has would otherwise make the bundle the
 * project's whole history.
 */
const sharedCommits = async (from: Side, fromRepo: string, to: Side, toRepo: string): Promise<string[]> => {
    const shared = new Set<string>();
    for (const tip of await recentTips(from, fromRepo)) if (await hasCommit(to, toRepo, tip)) shared.add(tip);
    for (const tip of await recentTips(to, toRepo)) if (!shared.has(tip) && (await hasCommit(from, fromRepo, tip))) shared.add(tip);
    return [...shared];
};

/**
 * Move each `+src:dst` from `from`'s repository to `to`'s: resolve `src` there, send the commits `to`
 * lacks as a git bundle, unbundle them, and point `dst` at the commit.
 *
 * A bundle holds only what the receiving side cannot already have: every commit `sharedCommits` finds is
 * excluded, so a card's push carries its new commits rather than the project's whole history. A commit
 * the receiver already has needs no bundle at all, only the ref.
 */
const transfer = async (from: Side, fromRepo: string, to: Side, toRepo: string, refspecs: readonly string[]): Promise<void> => {
    for (const refspec of refspecs.map(parseRefspec)) {
        const sha = (await from.git(fromRepo, ['rev-parse', '--verify', `${refspec.src}^{commit}`])).trim();
        if (!(await hasCommit(to, toRepo, sha))) await sendBundle(from, fromRepo, to, toRepo, sha);
        await to.git(toRepo, ['update-ref', refspec.dst, sha]);
    }
};

const sendBundle = async (from: Side, fromRepo: string, to: Side, toRepo: string, sha: string): Promise<void> => {
    const shared = await sharedCommits(from, fromRepo, to, toRepo);

    // A bundle names refs, not bare commits, so the commit gets a ref of its own for as long as it takes.
    const transferRef = `refs/wilson-transfer/${randomUUID()}`;
    const fromDir = await from.scratch(fromRepo);
    const toDir = await to.scratch(toRepo);
    const fromPath = posix.join(fromDir, 'transfer.bundle');
    const toPath = posix.join(toDir, `${randomUUID()}.bundle`);
    try {
        await from.git(fromRepo, ['update-ref', transferRef, sha]);
        await from.git(fromRepo, ['bundle', 'create', '--quiet', fromPath, transferRef, ...shared.map(tip => `^${tip}`)]);
        await to.writeBytes(toPath, await from.readBytes(fromPath));
        await to.git(toRepo, ['bundle', 'unbundle', toPath]);
    } finally {
        await from.git(fromRepo, ['update-ref', '-d', transferRef]).catch(() => undefined);
        await from.remove(fromPath).catch(() => undefined);
        await to.remove(toPath).catch(() => undefined);
        await from.release(fromDir).catch(() => undefined);
        await to.release(toDir).catch(() => undefined);
    }
};

/**
 * Commits to and from a worker's clone, over the worker's own connection: no git server, no SSH, and
 * nothing the worker can reach that it could not before. Each transfer is git's own bundle format,
 * written and unbundled by git on each side, so what arrives is checked by git exactly as a fetch is.
 */
export class WorkerGitTransport implements GitTransport {
    constructor(private readonly connection: WorkerConnection) {}

    async push(localRepo: string, remoteRepo: string, refspecs: readonly string[]): Promise<void> {
        await transfer(local, localRepo, remote(this.connection), remoteRepo, refspecs);
    }

    async fetch(localRepo: string, remoteRepo: string, refspecs: readonly string[]): Promise<void> {
        await transfer(remote(this.connection), remoteRepo, local, localRepo, refspecs);
    }
}
