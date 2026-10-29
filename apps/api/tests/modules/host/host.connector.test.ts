import { describe, expect, it } from 'vitest';
import { HostConnector, WorkerNotConnectedError } from '#modules/host/host.connector.js';
import { SshHost } from '#modules/host/ssh.execution.host.js';
import { SshGitTransport } from '#modules/host/ssh.git.transport.js';
import { WorkerConnections } from '#modules/worker/worker.connections.js';
import { WorkerExecutionHost } from '#modules/worker/worker.execution.host.js';
import { WorkerGitTransport } from '#modules/worker/worker.git.transport.js';
import { eventually, FakeWorker, startWorkerServer, workerRow } from '#tests/support/fake.worker.js';

describe('HostConnector', () => {
    const connector = new HostConnector('ssh');

    it('reaches an SSH host over SSH, for both its commands and its git transfers', () => {
        const row = { name: 'agent-3', kind: 'ssh' as const, sshTarget: 'agent-3', commandEnv: [] };

        expect(connector.connect(row)).toBeInstanceOf(SshHost);
        expect(connector.gitTransport(row)).toBeInstanceOf(SshGitTransport);
    });

    it('refuses a worker host whose worker is not connected', () => {
        const row = { name: 'unraid-vm', kind: 'worker' as const, commandEnv: [] };

        expect(() => connector.connect(row)).toThrow(WorkerNotConnectedError);
        expect(() => new HostConnector('ssh', undefined, new WorkerConnections()).connect(row)).toThrow(
            'host unraid-vm is a worker, and no worker is connected for it',
        );
    });

    it('reaches a connected worker over its connection, for both its commands and its commits', async () => {
        const server = await startWorkerServer({ token: workerRow('unraid-vm') });
        try {
            await FakeWorker.connect(server.url, 'token');
            await eventually(() => server.connections.get('unraid-vm') !== undefined);
            const workers = new HostConnector('ssh', undefined, server.connections);
            const row = { name: 'unraid-vm', kind: 'worker' as const, commandEnv: ['GITHUB_TOKEN'] };

            const host = workers.connect(row);

            expect(host).toBeInstanceOf(WorkerExecutionHost);
            expect(host.commandEnv).toEqual(['GITHUB_TOKEN']);
            expect(workers.gitTransport(row)).toBeInstanceOf(WorkerGitTransport);
        } finally {
            await server.close();
        }
    });
});
