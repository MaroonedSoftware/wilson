import { mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ExecFailure } from '#modules/host/execution.host.js';
import { localHost } from '#modules/host/local.execution.host.js';

/**
 * `LocalHost` is only worth having if routing a caller through it changes nothing, so every case
 * here pins it to the `node:fs/promises` or `execFile` behaviour the stage tools relied on before the
 * seam existed: the same content, the same rejections, the same error fields.
 */
describe('LocalHost', () => {
    let root: string;

    beforeAll(async () => {
        root = await mkdtemp(join(tmpdir(), 'local-host-'));
    });

    it('writes a file that readFile returns, and stat reports as a file', async () => {
        await localHost.mkdir(join(root, 'a', 'b'));
        await localHost.writeFile(join(root, 'a', 'b', 'c.txt'), 'hello');

        expect(await localHost.readFile(join(root, 'a', 'b', 'c.txt'))).toBe('hello');
        expect(await readFile(join(root, 'a', 'b', 'c.txt'), 'utf8')).toBe('hello');
        expect(await localHost.stat(join(root, 'a', 'b', 'c.txt'))).toMatchObject({ isDirectory: false });
        expect(await localHost.stat(join(root, 'a'))).toMatchObject({ isDirectory: true });
    });

    it('reports a file’s mtime as node:fs does', async () => {
        await localHost.writeFile(join(root, 'timed.txt'), 'x');
        expect((await localHost.stat(join(root, 'timed.txt'))).mtimeMs).toBe((await stat(join(root, 'timed.txt'))).mtimeMs);
    });

    it('resolves a path through realpath, and copies a file on the same machine', async () => {
        expect(await localHost.realpath(root)).toBe(await realpath(root));
        await expect(localHost.realpath(join(root, 'missing'))).rejects.toThrow(/ENOENT/);

        await localHost.writeFile(join(root, 'from.txt'), 'copied');
        await localHost.copyFile(join(root, 'from.txt'), join(root, 'to.txt'));
        expect(await readFile(join(root, 'to.txt'), 'utf8')).toBe('copied');
    });

    it('rejects a read or stat of a missing file the way node:fs does', async () => {
        await expect(localHost.readFile(join(root, 'missing.txt'))).rejects.toThrow(/ENOENT/);
        await expect(localHost.stat(join(root, 'missing.txt'))).rejects.toThrow(/ENOENT/);
    });

    it('does not create parent directories on writeFile', async () => {
        await expect(localHost.writeFile(join(root, 'no', 'such', 'dir.txt'), 'x')).rejects.toThrow(/ENOENT/);
    });

    it('unlinks a file, and removeTree removes a directory and tolerates one that is absent', async () => {
        await localHost.writeFile(join(root, 'gone.txt'), 'x');
        await localHost.unlink(join(root, 'gone.txt'));
        await expect(stat(join(root, 'gone.txt'))).rejects.toThrow();

        await localHost.mkdir(join(root, 'tree', 'deep'));
        await writeFile(join(root, 'tree', 'deep', 'f.txt'), 'x', 'utf8');
        await localHost.removeTree(join(root, 'tree'));
        await expect(stat(join(root, 'tree'))).rejects.toThrow();
        await expect(localHost.removeTree(join(root, 'tree'))).resolves.toBeUndefined();
    });

    it('runs a command in cwd with the given env and returns its output', async () => {
        const result = await localHost.exec(process.execPath, ['-e', 'process.stdout.write(process.cwd() + "|" + process.env.HOST_TEST)'], {
            cwd: root,
            env: { HOST_TEST: 'yes' },
        });

        // macOS resolves the tmpdir through /private, so compare the tail.
        expect(result.stdout.endsWith(`${root.split('/').pop()}|yes`)).toBe(true);
        expect(result.stderr).toBe('');
    });

    it('rejects a non-zero exit with the exit code and both streams, as execFile does', async () => {
        const failure = (await localHost
            .exec(process.execPath, ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)'], { cwd: root })
            .catch((err: ExecFailure) => err)) as ExecFailure;

        expect(failure).toBeInstanceOf(Error);
        expect(failure.code).toBe(3);
        expect(failure.stdout).toBe('out');
        expect(failure.stderr).toBe('err');
    });

    it('kills a command that outlives its timeout and says so', async () => {
        const failure = (await localHost
            .exec(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { cwd: root, timeoutMs: 200 })
            .catch((err: ExecFailure) => err)) as ExecFailure;

        expect(failure.killed).toBe(true);
    });

    it('keeps execFile’s default output cap when the caller sets no maxBuffer', async () => {
        // Two MiB against execFile's one MiB default. Passing `maxBuffer: undefined` through would
        // have lifted the cap entirely and resolved this.
        const failure = await localHost
            .exec(process.execPath, ['-e', 'process.stdout.write("x".repeat(2 * 1024 * 1024))'], { cwd: root })
            .catch((err: ExecFailure) => err);

        expect(failure).toBeInstanceOf(Error);
        expect((failure as ExecFailure).code).toBe('ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
    });
});
