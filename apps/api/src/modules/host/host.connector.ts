import type { ExecutionHost } from './execution.host.js';
import type { GitTransport } from './git.transport.js';
import type { HostRow } from './host.repository.js';
import { gitSshCommand, SshHost } from './ssh.execution.host.js';
import { SshGitTransport } from './ssh.git.transport.js';
import type { WorkerConnections } from '#modules/worker/worker.connections.js';
import { WorkerExecutionHost } from '#modules/worker/worker.execution.host.js';
import { WorkerGitTransport } from '#modules/worker/worker.git.transport.js';

/**
 * Turns a registered host into the `ExecutionHost` that reaches it. One place for it, so the probe and
 * placement connect the same way, and so a test can hand both a stand-in `ssh`.
 *
 * Registered as an instance (`HostModule`), not a class: its one parameter is a binary path, not
 * something the container could resolve.
 */
export class HostConnector {
    /**
     * @param engineToken What every SSH host's engine signs in with (`REMOTE_CLAUDE_CODE_OAUTH_TOKEN`);
     *   see `SshHost`'s parameter of the same name.
     * @param workers The worker connections open now. Absent, as in tests of SSH hosts alone, no
     *   worker host is ever connected.
     * @param workerEngineToken The token assigned to a worker host now. Called at each engine start,
     *   so a replaced or removed token needs no reconnect. Absent, every worker uses its own.
     */
    constructor(
        private readonly sshCommand = 'ssh',
        private readonly engineToken?: string,
        private readonly workers?: WorkerConnections,
        private readonly workerEngineToken?: (hostName: string) => Promise<string | undefined>,
    ) {}

    /**
     * The host's commands and files: over SSH, or over its worker's connection. Throws
     * {@link WorkerNotConnectedError} for a worker host whose worker is not connected.
     *
     * Given the host's `projects`, a worker is told them again first, so the project roots it confines
     * file work to are the ones registered now rather than the ones it was welcomed with.
     */
    connect(host: Pick<HostRow, 'name' | 'kind' | 'sshTarget' | 'commandEnv'> & Partial<Pick<HostRow, 'projects'>>): ExecutionHost {
        if (host.kind === 'worker') {
            const connection = this.workerConnection(host.name);
            if (host.projects) connection.send({ type: 'welcome', host: host.name, projects: host.projects });
            return new WorkerExecutionHost(connection, host.commandEnv, async () => this.workerEngineToken?.(host.name));
        }
        return new SshHost(sshTargetOf(host), this.sshCommand, host.commandEnv, this.engineToken);
    }

    /**
     * How commits reach a host's clone and come back from it: git over SSH, or bundles over a worker's
     * connection. Throws {@link WorkerNotConnectedError} as `connect` does.
     */
    gitTransport(host: Pick<HostRow, 'name' | 'kind' | 'sshTarget'>): GitTransport {
        if (host.kind === 'worker') return new WorkerGitTransport(this.workerConnection(host.name));
        return new SshGitTransport(sshTargetOf(host), gitSshCommand(this.sshCommand));
    }

    private workerConnection(name: string) {
        const connection = this.workers?.get(name);
        if (!connection) throw new WorkerNotConnectedError(name);
        return connection;
    }
}

/**
 * Thrown for a worker host whose worker is not connected: there is nothing to reach it through until
 * it connects in. The probe reports such a host as not connected, so placement never gets this far
 * with one; this is the backstop if it ever does.
 */
export class WorkerNotConnectedError extends Error {
    constructor(readonly hostName: string) {
        super(`host ${hostName} is a worker, and no worker is connected for it`);
        this.name = 'WorkerNotConnectedError';
    }
}

const sshTargetOf = (host: Pick<HostRow, 'name' | 'sshTarget'>): string => {
    if (host.sshTarget === undefined) throw new Error(`host ${host.name} has no SSH target`);
    return host.sshTarget;
};
