import { chmod, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExecFailure } from '#modules/host/execution.host.js';
import { WorkerConnectionLostError } from '#modules/worker/worker.connection.js';
import { WorkerExecutionHost } from '#modules/worker/worker.execution.host.js';
import { connectLoopbackWorker, eventually, startWorkerServer, workerRow } from '#tests/support/fake.worker.js';

/**
 * `WorkerExecutionHost` against the worker program's real executor, over a real connection: the same
 * cases `ssh.execution.host.test.ts` and `local.execution.host.test.ts` cover, since the point of the
 * host seam is that every host behaves alike.
 */
let root: string;
let fakeClaude: string;
let server: Awaited<ReturnType<typeof startWorkerServer>>;
let host: WorkerExecutionHost;

beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'worker-host-')));
    fakeClaude = join(root, 'claude');
    await writeFile(
        fakeClaude,
        '#!/bin/sh\nif [ "$1" = auth ]; then echo "{\\"loggedIn\\": true}"; exit 0; fi\necho "token=${CLAUDE_CODE_OAUTH_TOKEN-none} args=$*"\nwhile IFS= read -r line; do echo "got:$line"; done\n',
        'utf8',
    );
    await chmod(fakeClaude, 0o755);

    server = await startWorkerServer({ token: workerRow('unraid-vm') });
    await connectLoopbackWorker(server.url, 'token', {
        env: { PATH: process.env.PATH, HOME: '/home/worker', CLAUDE_CODE_OAUTH_TOKEN: 'worker-token' },
        claudeCommand: fakeClaude,
    });
    await eventually(() => server.connections.get('unraid-vm') !== undefined);
    host = new WorkerExecutionHost(server.connections.get('unraid-vm')!);
});

afterAll(async () => {
    await server.close();
});

describe('WorkerExecutionHost', () => {
    it('names itself after its host', () => {
        expect(host.name).toBe('worker:unraid-vm');
    });

    it('writes, reads and stats a file, and reports a missing one with an ENOENT message, as node:fs does', async () => {
        const dir = join(root, 'a dir');
        await host.mkdir(dir);
        const path = join(dir, "it's.txt");
        await host.writeFile(path, 'line one\n');

        expect(await host.readFile(path)).toBe('line one\n');
        expect(await readFile(path, 'utf8')).toBe('line one\n');
        expect(await host.stat(path)).toMatchObject({ isDirectory: false });
        expect(await host.stat(dir)).toMatchObject({ isDirectory: true });

        const missing = (await host.readFile(join(root, 'missing')).catch((err: unknown) => err)) as ExecFailure;
        expect(missing.code).toBe('ENOENT');
        expect(missing.message).toMatch(/^ENOENT: no such file or directory/);
    });

    it('resolves a symlink, copies, unlinks and removes a tree', async () => {
        const target = join(root, 'target.txt');
        await writeFile(target, 'x', 'utf8');
        await symlink(target, join(root, 'link'));

        expect(await host.realpath(join(root, 'link'))).toBe(target);
        await host.copyFile(target, join(root, 'copy.txt'));
        expect(await readFile(join(root, 'copy.txt'), 'utf8')).toBe('x');
        await host.unlink(join(root, 'copy.txt'));
        await expect(host.stat(join(root, 'copy.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
        await host.mkdir(join(root, 'tree', 'deep'));
        await host.removeTree(join(root, 'tree'));
        await expect(host.stat(join(root, 'tree'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('runs a command in cwd with the env given, keeping the worker’s own PATH and HOME', async () => {
        const result = await host.exec('sh', ['-c', 'echo "$(pwd)|$STAGE|$HOME"'], { cwd: root, env: { STAGE: 'testing', HOME: '/home/wilson' } });

        expect(result.stdout).toBe(`${root}|testing|/home/worker\n`);
    });

    it('rejects a non-zero exit with the code and both streams, and kills a command that outlives its timeout', async () => {
        const failed = (await host.exec('sh', ['-c', 'echo out; echo err >&2; exit 3'], { cwd: root }).catch((err: unknown) => err)) as ExecFailure;
        expect(failed).toMatchObject({ code: 3, stdout: 'out\n', stderr: 'err\n' });

        await expect(host.exec('sleep', ['5'], { cwd: root, timeoutMs: 100 })).rejects.toMatchObject({ killed: true });
    });

    it('runs claude for the probe as the engine would start, with the worker’s own sign-in', async () => {
        expect((await host.runClaude(['auth', 'status'], 5_000)).stdout).toBe('{"loggedIn": true}\n');
    });

    it('starts the engine on the worker with its stdio carried back here', async () => {
        const engine = host.spawnClaude({ command: 'claude', args: ['--print'], cwd: root, env: { CLAUDE_CODE_OAUTH_TOKEN: 'from-wilson' } });
        let stdout = '';
        engine.stdout!.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
        const exited = new Promise<number | null>(resolve => engine.on('exit', code => resolve(code)));

        engine.stdin!.write('hello\n');
        engine.stdin!.end();

        expect(await exited).toBe(0);
        expect(engine.exitCode).toBe(0);
        await eventually(() => stdout.includes('got:hello'));
        expect(stdout).toBe('token=worker-token args=--print\ngot:hello\n');
    });
});

describe('WorkerExecutionHost when the worker goes away', () => {
    it('ends a running engine and fails calls as a lost connection, which a stage retries', async () => {
        const lostServer = await startWorkerServer({ token: workerRow('flaky') });
        try {
            const flaky = await connectLoopbackWorker(lostServer.url, 'token', { claudeCommand: fakeClaude });
            await eventually(() => lostServer.connections.get('flaky') !== undefined);
            const flakyHost = new WorkerExecutionHost(lostServer.connections.get('flaky')!);
            const engine = flakyHost.spawnClaude({ command: 'claude', args: [], cwd: root, env: {} });
            const exited = new Promise<number | null>(resolve => engine.on('exit', code => resolve(code)));

            flaky.socket.terminate();

            expect(await exited).toBeNull();
            await expect(flakyHost.readFile(join(root, 'target.txt'))).rejects.toBeInstanceOf(WorkerConnectionLostError);
        } finally {
            await lostServer.close();
        }
    });
});
