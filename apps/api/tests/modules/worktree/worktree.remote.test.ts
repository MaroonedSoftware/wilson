import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import type { ExecutionHost } from '#modules/host/execution.host.js';
import type { GitTransport } from '#modules/host/git.transport.js';
import type { RemotePlacement } from '#modules/host/placement.js';
import { gitSshCommand, SshHost } from '#modules/host/ssh.execution.host.js';
import { SshGitTransport } from '#modules/host/ssh.git.transport.js';
import { WorkerExecutionHost } from '#modules/worker/worker.execution.host.js';
import { WorkerGitTransport } from '#modules/worker/worker.git.transport.js';
import { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import { connectLoopbackWorker, eventually, startWorkerServer, workerRow } from '#tests/support/fake.worker.js';

const exec = promisify(execFile);

/**
 * A card's worktree on a host, end to end: this machine's code repo, a second repo standing in for
 * the host's clone, and the host reached each way Wilson reaches one. Over SSH, the stand-in `ssh`
 * (`tests/support/fake.ssh.sh`) carries both the host's commands and git's own push and fetch. On a
 * worker, the worker program's own executor answers over a real connection and commits move as git
 * bundles. Everything git and the shell do is real; only the network hop is not.
 */
const FAKE_SSH = fileURLToPath(new URL('../../support/fake.ssh.sh', import.meta.url));
const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const git = async (cwd: string, ...args: string[]) => (await exec('git', args, { cwd })).stdout.trim();

/** How each way of reaching a host is set up for these tests, and torn down after. */
interface Reach {
    name: string;
    open: () => Promise<{ host: ExecutionHost; git: GitTransport; close: () => Promise<void> }>;
}

const reaches: Reach[] = [
    {
        name: 'over SSH',
        open: async () => ({
            host: new SshHost('agent-t', FAKE_SSH),
            git: new SshGitTransport('agent-t', gitSshCommand(FAKE_SSH)),
            close: async () => {},
        }),
    },
    {
        name: 'on a worker',
        open: async () => {
            const server = await startWorkerServer({ token: workerRow('agent-t') });
            await connectLoopbackWorker(server.url, 'token');
            await eventually(() => server.connections.get('agent-t') !== undefined);
            const connection = server.connections.get('agent-t')!;
            return { host: new WorkerExecutionHost(connection), git: new WorkerGitTransport(connection), close: server.close };
        },
    },
];

describe.each(reaches)('WorktreeManager on a host $name', reach => {
    let close: () => Promise<void>;
    let codeRoot: string;
    let hostClone: string;
    let runRoot: string;
    let placement: RemotePlacement;
    let manager: WorktreeManager;

    beforeAll(async () => {
        const base = await realpath(await mkdtemp(join(tmpdir(), 'worktree-remote-')));
        codeRoot = join(base, 'code');
        hostClone = join(base, 'host', 'clone');
        runRoot = join(base, 'run');
        for (const repo of [codeRoot, hostClone]) {
            await mkdir(repo, { recursive: true });
            await git(repo, 'init', '-q', '-b', 'main');
            await git(repo, 'config', 'user.email', 'test@example.com');
            await git(repo, 'config', 'user.name', 'Test');
        }
        await writeFile(join(codeRoot, 'README.md'), 'hello\n', 'utf8');
        await git(codeRoot, 'add', '-A');
        await git(codeRoot, 'commit', '-q', '-m', 'first');

        const opened = await reach.open();
        close = opened.close;
        placement = {
            hostName: 'agent-t',
            host: opened.host,
            git: opened.git,
            codeRoot: hostClone,
            worktreeRoot: join(base, 'host', 'wt'),
            runRoot: join(base, 'host', 'run'),
            slotKey: 'host:agent-t:slot:1',
        };
        manager = new WorktreeManager(new StaticBoardConfig('p', codeRoot, join(base, 'wt'), runRoot), logger as never);
    });

    afterAll(async () => {
        await close();
    });

    it('cuts the worktree in the host’s clone from this machine’s HEAD, commits there and fetches the branch back', async () => {
        const head = await git(codeRoot, 'rev-parse', 'HEAD');

        const worktree = await manager.create('0001', 'card/0001-remote', undefined, placement);

        expect(worktree.path).toBe(join(placement.worktreeRoot, '0001'));
        expect(worktree.baseSha).toBe(head);
        expect(worktree.placement).toBe(placement);
        expect(await readFile(join(worktree.path, 'README.md'), 'utf8')).toBe('hello\n');

        await placement.host.writeFile(join(worktree.path, 'new.txt'), 'from the host\n');
        expect(await manager.changedPaths(worktree)).toEqual(['new.txt']);
        const sha = await manager.commit(worktree, '0001: implementing');
        await manager.fetchBack(worktree);

        expect(await git(codeRoot, 'rev-parse', 'card/0001-remote')).toBe(sha);
        expect(await git(codeRoot, 'show', 'card/0001-remote:new.txt')).toBe('from the host');
        // Nothing a transfer used is left on either side.
        expect(await git(codeRoot, 'for-each-ref', 'refs/wilson-transfer')).toBe('');
        expect(await git(hostClone, 'for-each-ref', 'refs/wilson-transfer')).toBe('');
    });

    it('saves uncommitted work on the host to this machine’s patch path when it reclaims, and removes the tree', async () => {
        const worktree = await manager.resume('0001', 'card/0001-remote', placement);
        await placement.host.writeFile(join(worktree.path, 'unfinished.txt'), 'half done\n');

        await manager.reclaim('0001', placement);

        await expect(stat(worktree.path)).rejects.toThrow();
        expect(await readFile(manager.failedAttemptPatchPath('0001'), 'utf8')).toContain('+half done');
        expect(await git(hostClone, 'worktree', 'list')).not.toContain(worktree.path);
    });

    it('resumes the branch as this machine has it, and rebases it onto a HEAD the host had never seen', async () => {
        await writeFile(join(codeRoot, 'main-moved.txt'), 'main moved\n', 'utf8');
        await git(codeRoot, 'add', '-A');
        await git(codeRoot, 'commit', '-q', '-m', 'main moves on');
        const head = await git(codeRoot, 'rev-parse', 'HEAD');

        const worktree = await manager.resume('0001', 'card/0001-remote', placement);
        expect(await readFile(join(worktree.path, 'new.txt'), 'utf8')).toBe('from the host\n');

        const rebased = await manager.rebaseOntoHead(worktree);

        expect(rebased).toEqual({ ok: true, baseSha: head });
        expect(await readFile(join(worktree.path, 'main-moved.txt'), 'utf8')).toBe('main moved\n');
        await manager.reclaim('0001', placement);
    });

    it('cuts a second worktree on the host at a given commit, the way the testing baseline does', async () => {
        const first = await git(codeRoot, 'rev-list', '--max-parents=0', 'HEAD');

        const baseline = await manager.create('0001-baseline', 'card/0001-baseline', first, placement);

        expect(baseline.baseSha).toBe(first);
        await expect(stat(join(baseline.path, 'main-moved.txt'))).rejects.toThrow();
        await manager.reclaim('0001-baseline', placement);
        await expect(stat(baseline.path)).rejects.toThrow();
    });
});
