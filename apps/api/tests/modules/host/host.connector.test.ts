import { describe, expect, it } from 'vitest';
import { HostConnector, WorkerNotConnectedError } from '#modules/host/host.connector.js';
import { SshHost } from '#modules/host/ssh.execution.host.js';
import { SshGitTransport } from '#modules/host/ssh.git.transport.js';

describe('HostConnector', () => {
    const connector = new HostConnector('ssh');

    it('reaches an SSH host over SSH, for both its commands and its git transfers', () => {
        const row = { name: 'agent-3', kind: 'ssh' as const, sshTarget: 'agent-3', commandEnv: [] };

        expect(connector.connect(row)).toBeInstanceOf(SshHost);
        expect(connector.gitTransport(row)).toBeInstanceOf(SshGitTransport);
    });

    it('refuses a worker host, which nothing can reach yet', () => {
        const row = { name: 'unraid-vm', kind: 'worker' as const, commandEnv: [] };

        expect(() => connector.connect(row)).toThrow(WorkerNotConnectedError);
        expect(() => connector.gitTransport(row)).toThrow('host unraid-vm is a worker, and no worker is connected for it');
    });
});
