import type { ExecutionHost } from './execution.host.js';
import type { GitTransport } from './git.transport.js';
import type { HostRow } from './host.repository.js';
import { gitSshCommand, SshHost } from './ssh.execution.host.js';
import { SshGitTransport } from './ssh.git.transport.js';

/**
 * Turns a registered host into the `ExecutionHost` that reaches it. One place for it, so the probe and
 * placement connect the same way, and so a test can hand both a stand-in `ssh`.
 *
 * Registered as an instance (`HostModule`), not a class: its one parameter is a binary path, not
 * something the container could resolve.
 */
export class HostConnector {
    /**
     * @param engineToken What every host's engine signs in with (`REMOTE_CLAUDE_CODE_OAUTH_TOKEN`);
     *   see `SshHost`'s parameter of the same name.
     */
    constructor(
        private readonly sshCommand = 'ssh',
        private readonly engineToken?: string,
    ) {}

    connect(host: Pick<HostRow, 'sshTarget' | 'commandEnv'>): ExecutionHost {
        return new SshHost(host.sshTarget, this.sshCommand, host.commandEnv, this.engineToken);
    }

    /** How commits reach a host's clone and come back from it. */
    gitTransport(host: Pick<HostRow, 'sshTarget'>): GitTransport {
        return new SshGitTransport(host.sshTarget, gitSshCommand(this.sshCommand));
    }
}
