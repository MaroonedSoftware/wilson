/* eslint-disable turbo/no-undeclared-env-vars -- these tests hand the executor this machine's PATH to find sh and sleep with; nothing here is a build input */
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { FromWorker, ToWorker, WorkerStats } from '@wilson/worker-protocol';
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
    it('reports the machine, with each volume once and a root not made yet left out', async () => {
        const { call } = harness();
        const dir = await mkdtemp(join(root, 'stats-'));
        const other = join(dir, 'other');
        await mkdir(other);

        const answer = await call({ op: 'stats', paths: [join(dir, 'not-made-yet'), dir, other] });

        expect(answer.ok).toBe(true);
        const stats = (answer as { value: WorkerStats }).value;
        expect(stats.cpus).toBeGreaterThan(0);
        expect(stats.loadAverage).toBeGreaterThanOrEqual(0);
        expect(stats.memoryTotalBytes).toBeGreaterThan(0);
        expect(stats.memoryFreeBytes).toBeLessThanOrEqual(stats.memoryTotalBytes);
        expect(Number.isInteger(stats.uptimeSeconds)).toBe(true);
        expect(stats.disks.map(disk => disk.path)).toEqual([dir]);
        expect(stats.disks[0]!.totalBytes).toBeGreaterThan(0);
        expect(stats.disks[0]!.freeBytes).toBeLessThanOrEqual(stats.disks[0]!.totalBytes);
    });

    it('leaves a refused root out of its report and still answers', async () => {
        const dir = await mkdtemp(join(root, 'stats-'));
        const { call } = harness({ checkPath: path => (path === dir ? 'outside this host’s project roots' : undefined) });

        const answer = await call({ op: 'stats', paths: [dir] });

        expect(answer).toMatchObject({ ok: true, value: { disks: [] } });
    });

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

    it('starts codex for a spawn that names it, with no token and none of what Wilson sent', async () => {
        const fakeCodex = join(root, 'codex');
        await writeFile(fakeCodex, '#!/bin/sh\necho "codex $* token=${CLAUDE_CODE_OAUTH_TOKEN:-none} sent=${CLAUDE_CODE_ENTRYPOINT:-none}"\n');
        await chmod(fakeCodex, 0o755);
        const { executor, sent, waitFor } = harness({ codexCommand: fakeCodex });

        executor.handle({
            type: 'spawn',
            id: 'c1',
            engine: 'codex',
            command: 'rm',
            args: ['app-server'],
            cwd: root,
            env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' },
            engineToken: 'never-used',
        });
        await waitFor((m): m is Extract<FromWorker, { type: 'exit' }> => m.type === 'exit' && m.id === 'c1');

        const out = sent
            .filter((m): m is Extract<FromWorker, { type: 'out' }> => m.type === 'out' && m.id === 'c1')
            .map(m => Buffer.from(m.data, 'base64').toString())
            .join('');
        expect(out).toBe('codex app-server token=none sent=none\n');
    });

    it('refuses a codex spawn outside the projects it serves', async () => {
        const { executor, waitFor } = harness({
            codexCommand: 'true',
            checkPath: path => (path.startsWith(root) ? undefined : 'outside this host’s project roots'),
        });

        executor.handle({ type: 'spawn', id: 'c2', engine: 'codex', command: 'codex', args: [], cwd: '/etc', env: {} });
        const exit = await waitFor((m): m is Extract<FromWorker, { type: 'exit' }> => m.type === 'exit' && m.id === 'c2');

        expect(exit.error).toMatchObject({ code: 'EACCES' });
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
        void running.executor.killAll();
        expect(await running.waitFor((m): m is Extract<FromWorker, { type: 'exit' }> => m.type === 'exit')).toMatchObject({ signal: 'SIGTERM' });
    });

    describe('ending what it started', () => {
        type Exit = Extract<FromWorker, { type: 'exit' }>;
        type Result = Extract<FromWorker, { type: 'result' }>;

        /** Whether `pid` is gone, allowing a moment for the signal to land and the process to be reaped. */
        const gone = async (pid: number): Promise<boolean> => {
            for (let i = 0; i < 100; i++) {
                try {
                    process.kill(pid, 0);
                } catch {
                    return true;
                }
                await new Promise(resolve => setTimeout(resolve, 20));
            }
            return false;
        };

        /** A stand-in engine: runs `body`, having written `$!` of a background `sleep` to `pidFile`. */
        const fakeEngine = async (body: string): Promise<{ command: string; pidFile: string }> => {
            const dir = await mkdtemp(join(root, 'tree-'));
            const command = join(dir, 'engine');
            const pidFile = join(dir, 'pid');
            await writeFile(command, `#!/bin/sh\n${body.replaceAll('PIDFILE', pidFile)}\n`, 'utf8');
            await chmod(command, 0o755);
            return { command, pidFile };
        };

        const readPid = async (pidFile: string): Promise<number> => {
            for (;;) {
                const text = await readFile(pidFile, 'utf8').catch(() => '');
                if (text.endsWith('\n')) return Number(text.trim());
                await new Promise(resolve => setTimeout(resolve, 10));
            }
        };

        it('ends what an engine started along with the engine', async () => {
            const { command, pidFile } = await fakeEngine('sleep 60 &\necho $! > PIDFILE\nwait');
            const { executor, waitFor } = harness({ claudeCommand: command, killGraceMs: 50 });

            executor.handle({ type: 'spawn', id: 'tree', command: 'claude', args: [], env: {} });
            const pid = await readPid(pidFile);
            await executor.killAll();

            await waitFor((m): m is Exit => m.type === 'exit' && m.id === 'tree');
            expect(await gone(pid)).toBe(true);
        });

        it('ends a command an engine runs in a session of its own, as the real engine does', async () => {
            // A stand-in that stays alive holding a detached shell, which holds a sleep: no group of the
            // engine's reaches either of them.
            const dir = await mkdtemp(join(root, 'session-'));
            const command = join(dir, 'engine');
            const pidFile = join(dir, 'pid');
            const shell = `sleep 60 & echo $! > ${pidFile}; wait`;
            await writeFile(
                command,
                `#!${process.execPath}\nrequire('node:child_process').spawn('sh', ['-c', ${JSON.stringify(shell)}], { detached: true, stdio: 'ignore' });\nsetInterval(() => {}, 1000);\n`,
                'utf8',
            );
            await chmod(command, 0o755);
            const { executor, waitFor } = harness({ claudeCommand: command, killGraceMs: 50 });

            executor.handle({ type: 'spawn', id: 'session', command: 'claude', args: [], env: {} });
            const pid = await readPid(pidFile);
            await executor.killAll();

            await waitFor((m): m is Exit => m.type === 'exit' && m.id === 'session');
            expect(await gone(pid)).toBe(true);
        });

        it('ends the tree on a kill from Wilson too', async () => {
            const { command, pidFile } = await fakeEngine('sleep 60 &\necho $! > PIDFILE\nwait');
            const { executor, waitFor } = harness({ claudeCommand: command, killGraceMs: 50 });

            executor.handle({ type: 'spawn', id: 'asked', command: 'claude', args: [], env: {} });
            const pid = await readPid(pidFile);
            executor.handle({ type: 'kill', id: 'asked' });

            await waitFor((m): m is Exit => m.type === 'exit' && m.id === 'asked');
            expect(await gone(pid)).toBe(true);
        });

        it('kills an engine that ignores being told to stop, once its grace is up', async () => {
            const { command, pidFile } = await fakeEngine("trap '' TERM\nsleep 60 &\necho $! > PIDFILE\nwhile :; do wait; done");
            const { executor, waitFor } = harness({ claudeCommand: command, killGraceMs: 50 });

            executor.handle({ type: 'spawn', id: 'stubborn', command: 'claude', args: [], env: {} });
            const pid = await readPid(pidFile);
            await executor.killAll();

            expect(await waitFor((m): m is Exit => m.type === 'exit' && m.id === 'stubborn')).toMatchObject({ signal: 'SIGKILL' });
            expect(await gone(pid)).toBe(true);
        });

        it('kills what outlives an engine that did stop', async () => {
            const { command, pidFile } = await fakeEngine(
                // The survivor lets go of the pipes, so the engine's own exit is what Wilson hears first.
                "(trap '' TERM; exec sleep 60) > /dev/null 2>&1 < /dev/null &\necho $! > PIDFILE\nwait",
            );
            const { executor, waitFor } = harness({ claudeCommand: command, killGraceMs: 200 });

            executor.handle({ type: 'spawn', id: 'outlived', command: 'claude', args: [], env: {} });
            const pid = await readPid(pidFile);
            await new Promise(resolve => setTimeout(resolve, 50));
            const ended = executor.killAll();

            await waitFor((m): m is Exit => m.type === 'exit' && m.id === 'outlived');
            expect(() => process.kill(pid, 0)).not.toThrow();
            await ended;
            expect(await gone(pid)).toBe(true);
        });

        it('cancels a running command and what it started', async () => {
            const { command, pidFile } = await fakeEngine('sleep 60 &\necho $! > PIDFILE\nwait');
            const { executor, waitFor } = harness({ killGraceMs: 50 });

            executor.handle({ type: 'call', id: 'suite', call: { op: 'exec', file: command, args: [], options: { cwd: root } } });
            const pid = await readPid(pidFile);
            await executor.killAll();

            expect(await waitFor((m): m is Result => m.type === 'result' && m.id === 'suite')).toMatchObject({ ok: false, error: { killed: true } });
            expect(await gone(pid)).toBe(true);
        });

        it('ends what a command started when the command times out', async () => {
            const { command, pidFile } = await fakeEngine('sleep 60 &\necho $! > PIDFILE\nwait');
            const { call } = harness({ killGraceMs: 50 });

            const result = await call({ op: 'exec', file: command, args: [], options: { cwd: root, timeoutMs: 1_000 } });

            expect(result).toMatchObject({ ok: false, error: { killed: true } });
            expect(await gone(await readPid(pidFile))).toBe(true);
        });

        it('stops a command that overflows its buffer, with what it started, keeping what fitted', async () => {
            const { command, pidFile } = await fakeEngine('sleep 60 &\necho $! > PIDFILE\nprintf 123456\nwait');
            const { call } = harness({ killGraceMs: 50 });

            const result = await call({ op: 'exec', file: command, args: [], options: { cwd: root, maxBuffer: 4 } });

            expect(result).toMatchObject({
                ok: false,
                error: { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true, stdout: '1234' },
            });
            expect(await gone(await readPid(pidFile))).toBe(true);
        });

        it('has nothing to wait for when nothing is running', async () => {
            const { call, executor } = harness();

            await call({ op: 'exec', file: 'true', args: [], options: { cwd: root } });

            const started = Date.now();
            await executor.killAll();
            expect(Date.now() - started).toBeLessThan(1_000);
        });
    });

    describe('exec failures', () => {
        it('reports a command that cannot start as execFile does', async () => {
            const { call } = harness();

            expect(await call({ op: 'exec', file: join(root, 'no-such-command'), args: [], options: { cwd: root } })).toMatchObject({
                ok: false,
                error: { code: 'ENOENT' },
            });
        });

        it('leaves a command that produces less than its buffer alone', async () => {
            const { call } = harness();

            expect(await call({ op: 'exec', file: 'printf', args: ['123'], options: { cwd: root, maxBuffer: 4 } })).toMatchObject({
                ok: true,
                value: { stdout: '123' },
            });
        });
    });

    it('signs the engine in with a token Wilson sent, for that process alone', async () => {
        const { executor, waitFor, sent } = harness();

        executor.handle({ type: 'spawn', id: 'assigned', command: 'claude', args: [], cwd: root, env: {}, engineToken: 'assigned-token' });
        executor.handle({ type: 'stdin-end', id: 'assigned' });
        await waitFor((m): m is Extract<FromWorker, { type: 'exit' }> => m.type === 'exit' && m.id === 'assigned');
        executor.handle({ type: 'spawn', id: 'own', command: 'claude', args: [], cwd: root, env: {} });
        executor.handle({ type: 'stdin-end', id: 'own' });
        await waitFor((m): m is Extract<FromWorker, { type: 'exit' }> => m.type === 'exit' && m.id === 'own');

        const output = (id: string) =>
            sent.flatMap(m => (m.type === 'out' && m.id === id ? [Buffer.from(m.data, 'base64').toString()] : [])).join('');
        expect(output('assigned')).toContain('token=assigned-token');
        expect(output('own')).toContain('token=worker-token');
    });

    it('runs claude for the sign-in check with a token Wilson sent, on a worker with none', async () => {
        const { executor, waitFor } = harness({ env: { PATH: process.env.PATH } });

        executor.handle({ type: 'run-claude', id: 'check', args: ['auth', 'status'], timeoutMs: 5_000, engineToken: 'assigned-token' });

        const result = await waitFor((m): m is Extract<FromWorker, { type: 'result'; ok: true }> => m.type === 'result' && m.id === 'check');
        expect(result.value).toMatchObject({ stdout: 'token=assigned-token\n' });
    });

    it('keeps both tokens out of a command that inherits the worker’s environment, as a git hook would', async () => {
        const { executor, waitFor } = harness({
            env: { PATH: process.env.PATH, CLAUDE_CODE_OAUTH_TOKEN: 'worker-token', WILSON_WORKER_TOKEN: 'wilson_worker_x', KEPT: 'yes' },
        });

        executor.handle({
            type: 'call',
            id: 'inherit',
            call: { op: 'exec', file: 'sh', args: ['-c', 'echo "$CLAUDE_CODE_OAUTH_TOKEN|$WILSON_WORKER_TOKEN|$KEPT"'], options: { cwd: root } },
        });

        const result = await waitFor((m): m is Extract<FromWorker, { type: 'result'; ok: true }> => m.type === 'result' && m.id === 'inherit');
        expect(result.value).toMatchObject({ stdout: '||yes\n' });
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
