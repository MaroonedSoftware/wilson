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

    /** The host's commands and files. Throws for a `worker` host, which nothing can reach yet. */
    connect(host: Pick<HostRow, 'name' | 'kind' | 'sshTarget' | 'commandEnv'>): ExecutionHost {
        return new SshHost(sshTargetOf(host), this.sshCommand, host.commandEnv, this.engineToken);
    }

    /** How commits reach a host's clone and come back from it. Throws for a `worker` host, as `connect` does. */
    gitTransport(host: Pick<HostRow, 'name' | 'kind' | 'sshTarget'>): GitTransport {
        return new SshGitTransport(sshTargetOf(host), gitSshCommand(this.sshCommand));
    }
}

/**
 * Thrown for a `worker` host: it is reached over a connection its worker opens to the API, and
 * nothing accepts those yet. The probe reports such a host as not connected, so placement never gets
 * this far with one; this is the backstop if it ever does.
 */
export class WorkerNotConnectedError extends Error {
    constructor(readonly hostName: string) {
        super(`host ${hostName} is a worker, and no worker is connected for it`);
        this.name = 'WorkerNotConnectedError';
    }
}

const sshTargetOf = (host: Pick<HostRow, 'name' | 'kind' | 'sshTarget'>): string => {
    if (host.kind === 'worker' || host.sshTarget === undefined) throw new WorkerNotConnectedError(host.name);
    return host.sshTarget;
};
