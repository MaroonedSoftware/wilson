import type { ExecutionHost } from './execution.host.js';
import type { HostRow } from './host.repository.js';
import { SshHost } from './ssh.execution.host.js';

/**
 * Turns a registered host into the `ExecutionHost` that reaches it. One place for it, so the probe and
 * placement connect the same way, and so a test can hand both a stand-in `ssh`.
 *
 * Registered as an instance (`HostModule`), not a class: its one parameter is a binary path, not
 * something the container could resolve.
 */
export class HostConnector {
    constructor(private readonly sshCommand = 'ssh') {}

    connect(host: Pick<HostRow, 'sshTarget'>): ExecutionHost {
        return new SshHost(host.sshTarget, this.sshCommand);
    }
}
