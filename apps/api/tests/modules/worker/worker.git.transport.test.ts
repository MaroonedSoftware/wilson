import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { WorkerGitTransport } from '#modules/worker/worker.git.transport.js';
import { connectLoopbackWorker, eventually, startWorkerServer, workerRow } from '#tests/support/fake.worker.js';

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec('git', args, { cwd })).stdout.trim();

const LARGE_FILE_BYTES = 5 * 1024 * 1024;

describe('WorkerGitTransport', () => {
    it('sends only what is new when the two clones share no ref tip, as a clone from the forge will not', async () => {
        const base = await realpath(await mkdtemp(join(tmpdir(), 'worker-git-')));
        const code = join(base, 'code');
        const hostRoot = join(base, 'host');
        const clone = join(hostRoot, 'clone');
        await mkdir(code);
        await mkdir(hostRoot);
        await git(code, 'init', '-q', '-b', 'main');
        await git(code, 'config', 'user.email', 'test@example.com');
        await git(code, 'config', 'user.name', 'Test');
        await writeFile(join(code, 'large.bin'), randomBytes(LARGE_FILE_BYTES));
        await git(code, 'add', '-A');
        await git(code, 'commit', '-q', '-m', 'first');

        // The host's clone moves on from the commit it was cloned at, and so does this machine's.
        await exec('git', ['clone', '-q', code, clone]);
        await git(clone, 'config', 'user.email', 'test@example.com');
        await git(clone, 'config', 'user.name', 'Test');
        await git(clone, 'commit', '-q', '--allow-empty', '-m', 'on the forge only');
        await git(code, 'commit', '-q', '--allow-empty', '-m', 'merged here, not pushed');
        const head = await git(code, 'rev-parse', 'HEAD');

        const project = { project: 'p', codeRoot: hostRoot, worktreeRoot: hostRoot, runRoot: hostRoot };
        const server = await startWorkerServer({ token: workerRow('agent-t', [project]) });
        try {
            await connectLoopbackWorker(server.apiUrl, 'token');
            await eventually(() => server.connections.get('agent-t') !== undefined);
            const connection = server.connections.get('agent-t')!;
            const call = vi.spyOn(connection, 'call');

            await new WorkerGitTransport(connection).push(code, clone, [`+${head}:refs/heads/wilson-base`]);

            expect(await git(clone, 'rev-parse', 'refs/heads/wilson-base')).toBe(head);
            const sent = call.mock.calls.flatMap(([op]) => (op.op === 'writeBytes' ? [op.data.length] : []));
            expect(sent).toHaveLength(1);
            expect(sent[0]).toBeLessThan(LARGE_FILE_BYTES / 10);
        } finally {
            await server.close();
        }
    });
});
