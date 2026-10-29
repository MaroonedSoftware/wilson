/* eslint-disable turbo/no-undeclared-env-vars -- these tests set the environment the stand-in ssh hands its "remote" shell; nothing here is a build input */
import { chmod, mkdtemp, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ExecFailure } from '#modules/host/execution.host.js';
import { shellQuote, SshHost } from '#modules/host/ssh.execution.host.js';

/**
 * `SshHost` against a stand-in `ssh` (`tests/support/fake.ssh.sh`) that runs the remote command with
 * this machine's `sh`. Everything but the network is real: the quoting, the shell scripts each
 * primitive sends, and how exit codes and stderr come back. The cases mirror
 * `local.execution.host.test.ts`, since the point of the host seam is that the two behave alike.
 */
const FAKE_SSH = fileURLToPath(new URL('../../support/fake.ssh.sh', import.meta.url));

describe('SshHost', () => {
    const host = new SshHost('agent-3', FAKE_SSH);
    let root: string;

    beforeAll(async () => {
        root = await realpath(await mkdtemp(join(tmpdir(), 'ssh-host-')));
    });

    it('quotes any word so the shell takes it literally', () => {
        expect(shellQuote(`it's a "test" $HOME`)).toBe(`'it'\\''s a "test" $HOME'`);
    });

    it('writes, reads and stats a file whose name needs quoting', async () => {
        const dir = join(root, "a dir with 'quotes'");
        await host.mkdir(dir);
        const path = join(dir, 'f $x.txt');
        await host.writeFile(path, "line one\nit's $HOME\n");

        expect(await host.readFile(path)).toBe("line one\nit's $HOME\n");
        expect(await readFile(path, 'utf8')).toBe("line one\nit's $HOME\n");
        expect(await host.stat(path)).toMatchObject({ isDirectory: false });
        expect(await host.stat(dir)).toMatchObject({ isDirectory: true });
        expect(Math.abs((await host.stat(path)).mtimeMs - (await stat(path)).mtimeMs)).toBeLessThan(1000);
    });

    it('reports a missing path with an ENOENT message, as node:fs does', async () => {
        await expect(host.readFile(join(root, 'missing'))).rejects.toThrow(/^ENOENT: no such file or directory, open/);
        await expect(host.stat(join(root, 'missing'))).rejects.toThrow(/^ENOENT/);
        await expect(host.realpath(join(root, 'missing'))).rejects.toThrow(/^ENOENT/);
        await expect(host.unlink(join(root, 'missing'))).rejects.toThrow(/^ENOENT/);
    });

    it('resolves a symlink, copies, unlinks and removes a tree', async () => {
        await writeFile(join(root, 'target.txt'), 'x', 'utf8');
        await symlink(join(root, 'target.txt'), join(root, 'link.txt'));
        expect(await host.realpath(join(root, 'link.txt'))).toBe(join(root, 'target.txt'));

        await host.copyFile(join(root, 'target.txt'), join(root, 'copy.txt'));
        expect(await readFile(join(root, 'copy.txt'), 'utf8')).toBe('x');

        await host.unlink(join(root, 'copy.txt'));
        await expect(stat(join(root, 'copy.txt'))).rejects.toThrow();

        await host.mkdir(join(root, 'tree', 'deep'));
        await host.removeTree(join(root, 'tree'));
        await expect(stat(join(root, 'tree'))).rejects.toThrow();
        await expect(host.removeTree(join(root, 'tree'))).resolves.toBeUndefined();
    });

    it('runs a command in cwd with the env given, keeping the host’s own PATH and HOME', async () => {
        const result = await host.exec('sh', ['-c', 'printf "%s|%s|%s|%s" "$(pwd)" "$STAGE_VAR" "$PATH" "$SECRET"'], {
            cwd: root,
            env: { STAGE_VAR: "it's set", PATH: '/this/machine/only' },
        });

        const [cwd, stageVar, path, secret] = result.stdout.split('|');
        expect(cwd).toBe(root);
        expect(stageVar).toBe("it's set");
        // The host's PATH, not the one sent: the sent one names folders on this machine.
        expect(path).toBe(process.env.PATH);
        // `env -i`: nothing the host's shell had beyond what was passed reaches the command.
        expect(secret).toBe('');
    });

    it('starts from an empty environment, so a variable the remote shell has does not leak in', async () => {
        // The stand-in ssh hands its own environment to the "remote" shell, as a login shell has one.
        process.env.LEAKY = 'leaked';
        try {
            const result = await host.exec('sh', ['-c', 'printf "%s" "${LEAKY-unset}"'], { cwd: root, env: {} });
            expect(result.stdout).toBe('unset');
        } finally {
            delete process.env.LEAKY;
        }
    });

    it('rejects a non-zero exit with the code and both streams, as execFile does', async () => {
        const failure = (await host
            .exec('sh', ['-c', 'printf out; printf err >&2; exit 3'], { cwd: root })
            .catch((err: ExecFailure) => err)) as ExecFailure;

        expect(failure).toBeInstanceOf(Error);
        expect(failure.code).toBe(3);
        expect(failure.stdout).toBe('out');
        expect(failure.stderr).toBe('err');
    });

    it('does not run the command when the working folder is missing', async () => {
        const marker = join(root, 'ran-anyway');
        const failure = (await host.exec('touch', [marker], { cwd: join(root, 'no-such-folder') }).catch((err: ExecFailure) => err)) as ExecFailure;

        expect(failure.code).toBe(1);
        await expect(stat(marker)).rejects.toThrow();
    });

    it('kills a command that outlives its timeout and says so', async () => {
        const failure = (await host.exec('sleep', ['10'], { cwd: root, timeoutMs: 300 }).catch((err: ExecFailure) => err)) as ExecFailure;
        expect(failure.killed).toBe(true);
    });

    it('enforces maxBuffer the way execFile does', async () => {
        const failure = (await host.exec('sh', ['-c', 'head -c 3000000 /dev/zero'], { cwd: root }).catch((err: ExecFailure) => err)) as ExecFailure;
        expect(failure.code).toBe('ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
    });

    it('hands the engine its token over stdin, never on either machine’s command line', async () => {
        const argsLog = join(root, 'ssh-args.log');
        const loggingSsh = join(root, 'logging-ssh.sh');
        await writeFile(loggingSsh, `#!/bin/sh\nprintf '%s\\n' "$@" >> '${argsLog}'\nexec '${FAKE_SSH}' "$@"\n`, 'utf8');
        await chmod(loggingSsh, 0o755);
        const withToken = new SshHost('agent-3', loggingSsh, [], 'secret-engine-token');

        const child = withToken.spawnClaude({
            command: 'sh',
            args: ['-c', 'read line; printf "%s|%s" "$line" "$CLAUDE_CODE_OAUTH_TOKEN"'],
            cwd: root,
            // A token in this machine's environment is not the one sent: it would be on the command line.
            env: { CLAUDE_CODE_OAUTH_TOKEN: 'this-machine-token' },
        });
        let out = '';
        child.stdout!.on('data', (chunk: Buffer) => (out += chunk.toString()));
        child.stdin!.end('first message from the SDK\n');
        await new Promise(resolve => child.on('exit', resolve));

        expect(out).toBe('first message from the SDK|secret-engine-token');
        const args = await readFile(argsLog, 'utf8');
        expect(args).not.toContain('secret-engine-token');
        expect(args).not.toContain('this-machine-token');
    });

    it('runs claude the way the engine starts, token included, for the probe', async () => {
        const host = new SshHost('agent-3', FAKE_SSH, [], 'secret-engine-token');
        const original = process.env.PATH;
        const bin = join(root, 'bin');
        await host.mkdir(bin);
        await writeFile(join(bin, 'claude'), '#!/bin/sh\nprintf "%s %s" "$*" "${CLAUDE_CODE_OAUTH_TOKEN-none}"\n', 'utf8');
        await chmod(join(bin, 'claude'), 0o755);
        process.env.PATH = `${bin}:${original}`;
        try {
            expect((await host.runClaude(['auth', 'status'], 10_000)).stdout).toBe('auth status secret-engine-token');
        } finally {
            process.env.PATH = original;
        }
    });

    it('starts claude with the SDK’s own variables only, in the folder asked for, over stdio', async () => {
        const child = host.spawnClaude({
            command: 'sh',
            args: ['-c', 'read line; printf "%s|%s|%s|%s" "$line" "$(pwd)" "$CLAUDE_CODE_ENTRYPOINT" "${CLAUDE_CONFIG_DIR-unset}"'],
            cwd: root,
            env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', CLAUDE_CONFIG_DIR: '/this/machine/.claude', DATABASE_URL: 'postgres://secret' },
        });

        let out = '';
        child.stdout!.on('data', (chunk: Buffer) => (out += chunk.toString()));
        child.stdin!.end('hello\n');
        const code = await new Promise<number | null>(resolve => child.on('exit', resolve));

        expect(code).toBe(0);
        expect(out).toBe(`hello|${root}|sdk-ts|unset`);
    });
});
