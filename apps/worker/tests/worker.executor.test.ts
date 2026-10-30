/* eslint-disable turbo/no-undeclared-env-vars -- these tests hand the executor this machine's PATH to find sh and sleep with; nothing here is a build input */
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { FromWorker, ToWorker } from '@wilson/worker-protocol';
import { WorkerExecutor, type WorkerExecutorOptions } from '../src/worker.executor.js';

/**
 * The executor on its own: messages in, messages out, real files and processes on this machine. What
 * Wilson makes of the answers is `worker.execution.host.test.ts`'s business, in apps/api.
 */
let root: string;
let fakeClaude: string;

beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'worker-executor-')));
    // Echoes its stdin back, prefixed, and reports the token and folder it was started with.
    fakeClaude = join(root, 'claude');
    await writeFile(
        fakeClaude,
        '#!/bin/sh\nif [ "$1" = auth ]; then echo "token=${CLAUDE_CODE_OAUTH_TOKEN-none}"; exit 0; fi\necho "cwd=$(pwd) token=${CLAUDE_CODE_OAUTH_TOKEN-none} sdk=${CLAUDE_CODE_ENTRYPOINT-none} db=${DATABASE_URL-none}"\nwhile IFS= read -r line; do echo "got:$line"; done\necho "bye" >&2\nexit 3\n',
        'utf8',
    );
    await chmod(fakeClaude, 0o755);
});

/** An executor that collects what it sends, and a way to wait for a message matching a predicate. */
const harness = (options: WorkerExecutorOptions = {}) => {
    const sent: FromWorker[] = [];
    const waiters: Array<() => void> = [];
    const executor = new WorkerExecutor(
        message => {
            sent.push(message);
            for (const wake of waiters.splice(0)) wake();
        },
        { env: { PATH: process.env.PATH, HOME: '/home/worker', CLAUDE_CODE_OAUTH_TOKEN: 'worker-token' }, claudeCommand: fakeClaude, ...options },
    );
    const waitFor = async <T extends FromWorker>(match: (m: FromWorker) => m is T): Promise<T> => {
        for (;;) {
            const found = sent.find(match);
            if (found) return found;
            await new Promise<void>(resolve => waiters.push(resolve));
        }
    };
    const call = async (call: Extract<ToWorker, { type: 'call' }>['call']) => {
        const id = `${Math.random()}`;
        executor.handle({ type: 'call', id, call });
        return waitFor((m): m is Extract<FromWorker, { type: 'result' }> => m.type === 'result' && m.id === id);
    };
    return { executor, sent, waitFor, call };
};

describe('WorkerExecutor', () => {
    it('answers ping, and writes, reads, stats and removes files', async () => {
        const { call } = harness();
        const path = join(root, 'dir', 'f.txt');

        expect(await call({ op: 'ping' })).toMatchObject({ ok: true, value: 'pong' });
        expect(await call({ op: 'mkdir', path: join(root, 'dir') })).toMatchObject({ ok: true });
        expect(await call({ op: 'writeFile', path, content: 'hello\n' })).toMatchObject({ ok: true });
        expect(await readFile(path, 'utf8')).toBe('hello\n');
        expect(await call({ op: 'readFile', path })).toMatchObject({ ok: true, value: 'hello\n' });
        expect(await call({ op: 'stat', path })).toMatchObject({ ok: true, value: { isDirectory: false } });
        expect(await call({ op: 'removeTree', path: join(root, 'dir') })).toMatchObject({ ok: true });
        expect(await call({ op: 'readFile', path })).toMatchObject({ ok: false, error: { code: 'ENOENT' } });
    });

    it('reads and writes a file’s bytes as base64, binary included', async () => {
        const { call } = harness();
        const path = join(root, 'bytes.bin');
        const data = Buffer.from([0, 255, 10, 13, 128]);

        expect(await call({ op: 'writeBytes', path, data: data.toString('base64') })).toMatchObject({ ok: true });
        expect(await readFile(path)).toEqual(data);
        expect(await call({ op: 'readBytes', path })).toMatchObject({ ok: true, value: data.toString('base64') });
    });

    it('runs a command with Wilson’s env, but the passthrough names and hostEnv from its own', async () => {
        const { call } = harness({ env: { PATH: process.env.PATH, HOME: '/home/worker', GITHUB_TOKEN: 'gh', SECRET: 'no' } });

        const result = await call({
            op: 'exec',
            file: 'sh',
            args: ['-c', 'echo "$(pwd)|$HOME|$STAGE|${GITHUB_TOKEN-}|${SECRET-}"'],
            options: { cwd: root, env: { HOME: '/home/wilson', STAGE: 'testing' }, hostEnv: ['GITHUB_TOKEN'] },
        });

        expect(result).toMatchObject({ ok: true, value: { stdout: `${root}|/home/worker|testing|gh|\n` } });
    });

    describe('clone', () => {
        const source = async (): Promise<string> => {
            const repo = await mkdtemp(join(root, 'source-'));
            const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
            git('init', '-q', '-b', 'main');
            await writeFile(join(repo, 'a.txt'), 'hello\n', 'utf8');
            git('add', '-A');
            git('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'first');
            return repo;
        };

        it('clones into place, keeping neither the token nor anything half-made', async () => {
            const { call } = harness();
            const parent = await mkdtemp(join(root, 'clones-'));
            const path = join(parent, 'project', 'code');

            expect(await call({ op: 'clone', url: await source(), path, token: 'secret-token' })).toMatchObject({ ok: true });

            expect(await readFile(join(path, 'a.txt'), 'utf8')).toBe('hello\n');
            expect(await readFile(join(path, '.git', 'config'), 'utf8')).not.toContain('secret-token');
            expect(await readdir(join(parent, 'project'))).toEqual(['code']);
        });

        it('leaves nothing behind when the clone fails', async () => {
            const { call } = harness();
            const parent = await mkdtemp(join(root, 'clones-'));

            const result = await call({ op: 'clone', url: join(parent, 'no-such-repo'), path: join(parent, 'code'), token: 't' });

            expect(result).toMatchObject({ ok: false });
            expect(await readdir(parent)).toEqual([]);
        });

        it('takes a clone that landed first as its own, and refuses to replace anything else', async () => {
            const { call } = harness();
            const parent = await mkdtemp(join(root, 'clones-'));
            const url = await source();
            const path = join(parent, 'code');
            expect(await call({ op: 'clone', url, path, token: 't' })).toMatchObject({ ok: true });
            expect(await call({ op: 'clone', url, path, token: 't' })).toMatchObject({ ok: true });

            const occupied = join(await mkdtemp(join(root, 'clones-')), 'code');
            await mkdir(occupied);
            await writeFile(join(occupied, 'keep.txt'), 'mine\n', 'utf8');
            expect(await call({ op: 'clone', url, path: occupied, token: 't' })).toMatchObject({ ok: false });
            expect(await readFile(join(occupied, 'keep.txt'), 'utf8')).toBe('mine\n');
        });

        it('refuses a path outside its project roots before running git', async () => {
            const { call } = harness({ checkPath: () => 'outside this host’s project roots' });

            expect(await call({ op: 'clone', url: 'unused', path: '/etc/code', token: 't' })).toMatchObject({ ok: false, error: { code: 'EACCES' } });
        });
    });

    it('reports a failed command as execFile would: code, killed and both streams', async () => {
        const { call } = harness();

        const failed = await call({ op: 'exec', file: 'sh', args: ['-c', 'echo out; echo err >&2; exit 4'], options: { cwd: root } });
        const timedOut = await call({ op: 'exec', file: 'sleep', args: ['5'], options: { cwd: root, timeoutMs: 50 } });

        expect(failed).toMatchObject({ ok: false, error: { code: 4, stdout: 'out\n', stderr: 'err\n' } });
        expect(timedOut).toMatchObject({ ok: false, error: { killed: true } });
    });

    it('refuses a path its check refuses, before touching it', async () => {
        const { call } = harness({ checkPath: path => (path.startsWith(root) ? undefined : 'outside this host’s project roots') });

        expect(await call({ op: 'readFile', path: '/etc/hosts' })).toMatchObject({ ok: false, error: { code: 'EACCES' } });
        expect(await call({ op: 'exec', file: 'true', args: [], options: { cwd: '/' } })).toMatchObject({ ok: false, error: { code: 'EACCES' } });
    });

    it('spawns the engine with its own token and the SDK’s variables only, streaming stdio both ways', async () => {
        const { executor, sent, waitFor } = harness();

        executor.handle({
            type: 'spawn',
            id: 'e1',
            command: 'claude',
            args: [],
            cwd: root,
            env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', CLAUDE_CODE_OAUTH_TOKEN: 'wilson-token', DATABASE_URL: 'postgres://board' },
        });
        executor.handle({ type: 'stdin', id: 'e1', data: Buffer.from('one\ntwo\n').toString('base64') });
        executor.handle({ type: 'stdin-end', id: 'e1' });
        const exit = await waitFor((m): m is Extract<FromWorker, { type: 'exit' }> => m.type === 'exit' && m.id === 'e1');

        const stream = (name: 'stdout' | 'stderr') =>
            sent
                .filter((m): m is Extract<FromWorker, { type: 'out' }> => m.type === 'out' && m.stream === name)
                .map(m => Buffer.from(m.data, 'base64').toString())
                .join('');
        expect(stream('stdout')).toBe(`cwd=${root} token=worker-token sdk=sdk-ts db=none\ngot:one\ngot:two\n`);
        expect(stream('stderr')).toBe('bye\n');
        expect(exit).toMatchObject({ code: 3, signal: null });
    });

    it('reports an engine that cannot start as an exit with an error, and kills what it started on request', async () => {
        const missing = harness({ claudeCommand: join(root, 'no-such-claude') });
        missing.executor.handle({ type: 'spawn', id: 'x', command: 'claude', args: [], env: {} });
        expect(await missing.waitFor((m): m is Extract<FromWorker, { type: 'exit' }> => m.type === 'exit')).toMatchObject({
            code: null,
            error: { code: 'ENOENT' },
        });

        const running = harness();
        running.executor.handle({ type: 'spawn', id: 'k', command: 'claude', args: [], env: {} });
        running.executor.killAll();
        expect(await running.waitFor((m): m is Extract<FromWorker, { type: 'exit' }> => m.type === 'exit')).toMatchObject({ signal: 'SIGTERM' });
    });

    it('runs claude for the sign-in check with its own token', async () => {
        const { executor, waitFor } = harness();

        executor.handle({ type: 'run-claude', id: 'r', args: ['auth', 'status'], timeoutMs: 5_000 });

        expect(await waitFor((m): m is Extract<FromWorker, { type: 'result' }> => m.type === 'result' && m.id === 'r')).toMatchObject({
            ok: true,
            value: { stdout: 'token=worker-token\n' },
        });
    });
});
