import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@maroonedsoftware/logger';
import type { CallOp, ToWorker, WorkerStats } from '@wilson/worker-protocol';
import type { HostRepository, HostRow } from '#modules/host/host.repository.js';
import { WorkerStatsSampler } from '#modules/worker/worker.stats.sampler.js';
import { HostMetrics } from '../../../src/generated/hosts.js';
import { connectLoopbackWorker, eventually, FakeWorker, startWorkerServer, workerRow } from '#tests/support/fake.worker.js';

const project = { project: 'tga', codeRoot: '/srv/tga', worktreeRoot: '/srv/wt', runRoot: '/srv/run' };
const stats: WorkerStats = {
    cpus: 4,
    loadAverage: 1.5,
    memoryTotalBytes: 8,
    memoryFreeBytes: 2,
    uptimeSeconds: 60,
    disks: [{ path: '/srv/tga', totalBytes: 9, freeBytes: 3 }],
};

/** Real sockets on both ends. Only the host's row and the worker's answer are made up. */
let close: (() => Promise<void>) | undefined;
afterEach(async () => {
    await close?.();
    close = undefined;
});

const setup = async (answer: (call: CallOp, id: string, worker: FakeWorker) => void) => {
    const row: HostRow = workerRow('mac', [project]);
    const server = await startWorkerServer({ token: row });
    close = server.close;
    const warn = vi.fn();
    const sampler = new WorkerStatsSampler(server.connections, { find: async () => row } as unknown as HostRepository, { warn } as unknown as Logger);
    await FakeWorker.connect(server.url, 'token', (message: ToWorker, worker) => {
        if (message.type === 'call') answer(message.call, message.id, worker);
    });
    await eventually(() => server.connections.get('mac') !== undefined);
    return { sampler, connection: server.connections.get('mac')!, warn };
};

describe('WorkerStatsSampler', () => {
    it("asks about the host's project roots and keeps the answer on the connection", async () => {
        const asked: CallOp[] = [];
        const { sampler, connection } = await setup((call, id, worker) => {
            asked.push(call);
            worker.send({ type: 'result', id, ok: true, value: stats });
        });

        await sampler.sampleHost('mac');

        expect(asked).toEqual([{ op: 'stats', paths: ['/srv/tga', '/srv/wt', '/srv/run'] }]);
        expect(connection.latestStats).toMatchObject(stats);
        expect(connection.latestStats?.sampledAt.isValid).toBe(true);
    });

    it('takes a reading the API can return from the real worker program', async () => {
        const row: HostRow = workerRow('real', [{ project: 'tga', codeRoot: process.cwd(), worktreeRoot: process.cwd(), runRoot: process.cwd() }]);
        const server = await startWorkerServer({ token: row });
        close = server.close;
        const worker = await connectLoopbackWorker(server.apiUrl, 'token');
        await eventually(() => server.connections.get('real') !== undefined);
        const sampler = new WorkerStatsSampler(
            server.connections,
            { find: async () => row } as unknown as HostRepository,
            { warn: vi.fn() } as unknown as Logger,
        );

        await sampler.sampleHost('real');

        const metrics = server.connections.get('real')!.latestStats!;
        expect(HostMetrics.parse(metrics).disks).toHaveLength(1);
        expect(metrics.disks[0]?.path).toBe(process.cwd());
        worker.stop();
    });

    it('clears the last reading when a worker fails to give one, and does not throw', async () => {
        let healthy = true;
        const { sampler, connection, warn } = await setup((_call, id, worker) => {
            worker.send(healthy ? { type: 'result', id, ok: true, value: stats } : { type: 'result', id, ok: false, error: { message: 'no' } });
        });
        await sampler.sampleAll();
        expect(connection.latestStats).toBeDefined();

        healthy = false;
        await sampler.sampleAll();

        expect(connection.latestStats).toBeUndefined();
        expect(warn).toHaveBeenCalledOnce();
    });

    it('samples on its interval until told to stop', async () => {
        let asked = 0;
        const { sampler } = await setup((_call, id, worker) => {
            asked++;
            worker.send({ type: 'result', id, ok: true, value: stats });
        });
        const stop = new AbortController();

        sampler.start(stop.signal, 5);
        await eventually(() => asked >= 2);
        stop.abort();
        const settled = asked;
        await new Promise(resolve => setTimeout(resolve, 30));

        expect(asked).toBeLessThanOrEqual(settled + 1);
    });

    it('ignores a host with no worker connected', async () => {
        const { sampler, warn } = await setup(() => {});

        await sampler.sampleHost('nobody');

        expect(warn).not.toHaveBeenCalled();
    });
});
