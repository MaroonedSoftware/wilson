import type { ExecutionHost } from './execution.host.js';
import type { HostRow } from './host.repository.js';
import { gitSshCommand, SshHost } from './ssh.execution.host.js';

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

    /** `GIT_SSH_COMMAND` for pushing to and fetching from a host's clone. */
    gitSsh(): string {
        return gitSshCommand(this.sshCommand);
    }
}
