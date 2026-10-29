/* eslint-disable turbo/no-undeclared-env-vars -- these tests set the environment the stand-in ssh hands its "remote" shell; nothing here is a build input */
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { bashTool } from '#modules/agent/tools/bash.tool.js';
import type { ToolContext } from '#modules/agent/tools/tool.context.js';
import { CommandAllowlist } from '#modules/agent/command.allowlist.js';
import { localHost } from '#modules/host/local.execution.host.js';
import { SshHost } from '#modules/host/ssh.execution.host.js';
import { runConfiguredCommand } from '#modules/stages/run.command.js';

/**
 * A host's `commandEnv`: variables its own environment supplies to the commands stage config runs
 * there, and to nothing else. The stand-in `ssh` hands this process's environment to its "remote"
 * shell, as a login shell on an agent VM has the GITHUB_TOKEN its `.bashrc` exported, so setting a
 * variable here is setting it on the "host".
 */
const FAKE_SSH = fileURLToPath(new URL('../../support/fake.ssh.sh', import.meta.url));
const NAME = 'WILSON_TEST_PACKAGE_TOKEN';

let root: string;
beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'command-env-')));
});
afterEach(() => {
    delete process.env[NAME];
});

const printenv = (host: SshHost) =>
    host.exec('sh', ['-c', `printf "%s" "\${${NAME}-unset}"`], { cwd: root, env: { [NAME]: 'sent-from-this-machine' }, hostEnv: [NAME] });

describe('a host’s command env', () => {
    it('takes a named variable’s value from the host, not from what this machine sent', async () => {
        process.env[NAME] = 'the-host-value';
        expect((await printenv(new SshHost('agent-3', FAKE_SSH))).stdout).toBe('the-host-value');
    });

    it('leaves a named variable empty when the host does not have it', async () => {
        expect((await printenv(new SshHost('agent-3', FAKE_SSH))).stdout).toBe('');
    });

    it('reaches a configured command on a host that names it', async () => {
        process.env[NAME] = 'the-host-value';
        const host = new SshHost('agent-3', FAKE_SSH, [NAME]);

        expect(await runConfiguredCommand(root, `printenv ${NAME}`, undefined, undefined, host)).toBeUndefined();
        // The same command on a host that does not name it runs without it, and printenv says so.
        expect(await runConfiguredCommand(root, `printenv ${NAME}`, undefined, undefined, new SshHost('agent-3', FAKE_SSH))).toMatchObject({
            reason: expect.stringContaining('failed (exit 1)'),
        });
    });

    it('never reaches the agent’s bash tool, even on a host that names it', async () => {
        process.env[NAME] = 'the-host-value';
        const host = new SshHost('agent-3', FAKE_SSH, [NAME]);
        const context = {
            project: 'p',
            cardId: '0001',
            stage: 'implementing',
            worktreeRoot: root,
            commands: new CommandAllowlist([`printenv ${NAME}`]),
            events: { append: async () => {} },
            logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
            host,
        } as unknown as ToolContext;

        const output = await (bashTool(context).execute as unknown as (input: { command: string }) => Promise<string>)({
            command: `printenv ${NAME}`,
        });

        expect(output).toBe('exit code 1');
    });

    it('takes a named variable from this process on this machine', async () => {
        process.env[NAME] = 'local-value';
        const result = await localHost.exec('sh', ['-c', `printf "%s" "\${${NAME}-unset}"`], {
            cwd: root,
            env: { PATH: process.env.PATH },
            hostEnv: [NAME],
        });
        expect(result.stdout).toBe('local-value');
    });
});
