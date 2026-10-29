import type { GitTransport } from './git.transport.js';
import { localHost } from './local.execution.host.js';

/** Most bytes of git's own output to buffer; a push or fetch prints little, but a large one prints progress. */
const MAX_BUFFER = 32 * 1024 * 1024;

/**
 * Git's own push and fetch to a host's clone, addressed as `target:path` so git reaches it with `ssh`.
 *
 * `gitSsh` is `GIT_SSH_COMMAND` (`gitSshCommand`), so a transfer rides the same multiplexed
 * connection, with the same no-prompt options, as the host's other commands.
 */
export class SshGitTransport implements GitTransport {
    constructor(
        private readonly sshTarget: string,
        private readonly gitSsh: string,
    ) {}

    async push(localRepo: string, remoteRepo: string, refspecs: readonly string[]): Promise<void> {
        await this.git(localRepo, ['push', '--quiet', '--no-verify', this.remoteUrl(remoteRepo), ...refspecs]);
    }

    async fetch(localRepo: string, remoteRepo: string, refspecs: readonly string[]): Promise<void> {
        await this.git(localRepo, ['fetch', '--no-tags', this.remoteUrl(remoteRepo), ...refspecs]);
    }

    private remoteUrl(remoteRepo: string): string {
        return `${this.sshTarget}:${remoteRepo}`;
    }

    private async git(cwd: string, args: string[]): Promise<void> {
        await localHost.exec('git', args, { cwd, maxBuffer: MAX_BUFFER, env: { ...process.env, GIT_SSH_COMMAND: this.gitSsh } });
    }
}
