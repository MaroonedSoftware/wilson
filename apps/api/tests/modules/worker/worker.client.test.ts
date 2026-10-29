import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WorkerClient, WorkerStoppedError } from '@wilson/worker';
import { HostConnector } from '#modules/host/host.connector.js';
import { connectLoopbackWorker, eventually, startWorkerServer, workerRow } from '#tests/support/fake.worker.js';

/**
 * The worker program's `WorkerClient` against the real endpoint: what it does about the connection
 * itself. What it does with each primitive is `worker.execution.host.test.ts`'s business.
 */
let root: string;
const cleanups: Array<() => Promise<void> | void> = [];

beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'worker-client-')));
});
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const project = (name: string) => ({
    project: name,
    codeRoot: join(root, name),
    worktreeRoot: join(root, `${name}-wt`),
    runRoot: join(root, `${name}-run`),
});

const start = async (projects = [project('tga')]) => {
    const server = await startWorkerServer({ token: workerRow('unraid-vm', projects) });
    cleanups.push(server.close);
    return server;
};

describe('WorkerClient', () => {
    it('refuses file work outside its host’s project roots, and learns a project served since it connected', async () => {
        const server = await start();
        const client = await connectLoopbackWorker(server.apiUrl, 'token');
        cleanups.push(() => client.stop());
        const connector = new HostConnector('ssh', undefined, server.connections);
        const row = { name: 'unraid-vm', kind: 'worker' as const, commandEnv: [] };

        await expect(connector.connect(row).mkdir(join(root, 'elsewhere'))).rejects.toMatchObject({ code: 'EACCES' });
        await connector.connect(row).mkdir(join(root, 'tga', 'src'));

        // Connecting with the host's projects tells the worker them again, as a probe or placement does.
        const host = connector.connect({ ...row, projects: [project('tga'), project('wilson')] });
        await host.mkdir(join(root, 'wilson'));
        expect(await host.stat(join(root, 'wilson'))).toMatchObject({ isDirectory: true });
    });

    it('reconnects when Wilson drops the connection, and is welcomed again', async () => {
        const server = await start();
        const client = await connectLoopbackWorker(server.apiUrl, 'token');
        cleanups.push(() => client.stop());
        const first = server.connections.get('unraid-vm')!;

        first.close(1011, 'restarting');

        await eventually(() => server.connections.get('unraid-vm') !== undefined && server.connections.get('unraid-vm') !== first);
        expect(await client.welcomed()).toBe('unraid-vm');
    });

    it('stops for good when its token is refused', async () => {
        const server = await start();
        const client = new WorkerClient({ url: server.apiUrl, token: 'wrong', version: 'test', minReconnectMs: 10 });

        await expect(client.run()).rejects.toBeInstanceOf(WorkerStoppedError);
    });

    it('stops for good when another worker connects as the same host, leaving that one connected', async () => {
        const server = await start();
        const first = new WorkerClient({ url: server.apiUrl, token: 'token', version: 'test', minReconnectMs: 10 });
        const stopped = first.run();
        // Handled now: it settles while the second worker connects, before the expectation below.
        stopped.catch(() => undefined);
        await first.welcomed();

        const second = await connectLoopbackWorker(server.apiUrl, 'token');
        cleanups.push(() => second.stop());

        await expect(stopped).rejects.toThrow('another worker connected as the same host');
        await eventually(() => server.connections.get('unraid-vm') !== undefined);
    });
});
