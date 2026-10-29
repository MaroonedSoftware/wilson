import { afterEach, describe, expect, it } from 'vitest';
import { WorkerCloseCode } from '@wilson/worker-protocol';
import { PASSED_THROUGH } from '#modules/stages/run.command.js';
import { PASSED_THROUGH_ENV } from '@wilson/worker-protocol';
import { WorkerConnectionLostError } from '#modules/worker/worker.connection.js';
import { eventually, FakeWorker, startWorkerServer, workerRow } from '#tests/support/fake.worker.js';

const project = { project: 'tga', codeRoot: '/srv/tga', worktreeRoot: '/srv/wt', runRoot: '/srv/run' };

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
    await close?.();
    close = undefined;
});

const start = async (options: Parameters<typeof startWorkerServer>[1] = {}) => {
    const server = await startWorkerServer({ 'token-a': workerRow('unraid-vm', [project]), 'token-b': workerRow('mac') }, options);
    close = server.close;
    return server;
};

describe('the worker endpoint', () => {
    it('refuses a connection with no token or an unknown one, before it becomes a WebSocket', async () => {
        const { url } = await start();

        await expect(FakeWorker.connect(url, undefined)).rejects.toThrow('refused with 401');
        await expect(FakeWorker.connect(url, 'not-a-token')).rejects.toThrow('refused with 401');
        await expect(FakeWorker.connect(url.replace('/api/workers/connect', '/api/other'), 'token-a')).rejects.toThrow('refused with 404');
    });

    it('welcomes a worker as the host its token names, with that host’s projects, and keeps the connection', async () => {
        const { url, connections } = await start();

        const worker = await FakeWorker.connect(url, 'token-a');
        await eventually(() => worker.welcome !== undefined);

        expect(worker.welcome).toEqual({ type: 'welcome', host: 'unraid-vm', projects: [project] });
        await eventually(() => connections.get('unraid-vm') !== undefined);
        expect(connections.get('unraid-vm')?.hello).toEqual({ workerVersion: '0.0.1-test', platform: 'linux' });
        expect(connections.get('mac')).toBeUndefined();
    });

    it('closes a connection whose hello names another protocol version, or that sends something else first', async () => {
        const { url, connections } = await start();

        const old = await FakeWorker.connect(url, 'token-a', undefined, { type: 'hello', protocol: 0, workerVersion: 'old', platform: 'linux' });
        expect(await old.closed()).toBe(WorkerCloseCode.BadHello);

        const rude = await FakeWorker.connect(url, 'token-a', undefined, { type: 'result', id: 'x', ok: true });
        expect(await rude.closed()).toBe(WorkerCloseCode.BadHello);
        expect(connections.get('unraid-vm')).toBeUndefined();
    });

    it('closes a connection that never says hello', async () => {
        const { url } = await start({ helloTimeoutMs: 50 });

        const silent = await FakeWorker.connect(url, 'token-a', undefined, { nothing: true });

        expect(await silent.closed()).toBe(WorkerCloseCode.BadHello);
    });

    it('replaces an older connection for the same host with a newer one', async () => {
        const { url, connections } = await start();
        const first = await FakeWorker.connect(url, 'token-a');
        await eventually(() => connections.get('unraid-vm') !== undefined);
        const firstConnection = connections.get('unraid-vm');

        const second = await FakeWorker.connect(url, 'token-a');
        await eventually(() => second.welcome !== undefined && connections.get('unraid-vm') !== firstConnection);

        expect(await first.closed()).toBe(WorkerCloseCode.Superseded);
        expect(connections.get('unraid-vm')).toBeDefined();
    });

    it('closes every connection when the server shuts down', async () => {
        const abort = new AbortController();
        const { url, connections } = await start({ signal: abort.signal });
        const worker = await FakeWorker.connect(url, 'token-a');
        await eventually(() => connections.get('unraid-vm') !== undefined);

        abort.abort();

        expect(await worker.closed()).toBe(1001);
        expect(connections.get('unraid-vm')).toBeUndefined();
    });
});

describe('a worker connection', () => {
    it('round-trips a call, and rebuilds a failure as execFile would have thrown it', async () => {
        const { url, connections } = await start();
        await FakeWorker.connect(url, 'token-a', (message, worker) => {
            if (message.type !== 'call') return;
            if (message.call.op === 'ping') worker.send({ type: 'result', id: message.id, ok: true, value: 'pong' });
            else worker.send({ type: 'result', id: message.id, ok: false, error: { message: 'exit 2', code: 2, stdout: 'out', stderr: 'err' } });
        });
        await eventually(() => connections.get('unraid-vm') !== undefined);
        const connection = connections.get('unraid-vm')!;

        expect(await connection.call({ op: 'ping' })).toBe('pong');
        await expect(connection.call({ op: 'exec', file: 'false', args: [], options: { cwd: '/' } })).rejects.toMatchObject({
            message: 'exit 2',
            code: 2,
            stdout: 'out',
            stderr: 'err',
        });
    });

    it('fails every call still waiting when the worker goes away, and refuses calls after', async () => {
        const { url, connections } = await start();
        const worker = await FakeWorker.connect(url, 'token-a');
        await eventually(() => connections.get('unraid-vm') !== undefined);
        const connection = connections.get('unraid-vm')!;

        const waiting = connection.call({ op: 'readFile', path: '/srv/tga/README.md' });
        await eventually(() => worker.received.some(m => m.type === 'call'));
        worker.socket.terminate();

        await expect(waiting).rejects.toBeInstanceOf(WorkerConnectionLostError);
        await eventually(() => !connection.open);
        await expect(connection.call({ op: 'ping' })).rejects.toBeInstanceOf(WorkerConnectionLostError);
        expect(connections.get('unraid-vm')).toBeUndefined();
    });

    it('times out a call the worker never answers', async () => {
        const { url, connections } = await start();
        await FakeWorker.connect(url, 'token-a');
        await eventually(() => connections.get('unraid-vm') !== undefined);

        await expect(connections.get('unraid-vm')!.call({ op: 'ping' }, 50)).rejects.toMatchObject({ killed: true });
    });

    it('streams a spawned process’s output to its listener, and ends it when the connection closes', async () => {
        const { url, connections } = await start();
        const worker = await FakeWorker.connect(url, 'token-a', (message, w) => {
            if (message.type === 'spawn') w.send({ type: 'out', id: message.id, stream: 'stdout', data: Buffer.from('hi').toString('base64') });
        });
        await eventually(() => connections.get('unraid-vm') !== undefined);
        const seen: string[] = [];

        connections
            .get('unraid-vm')!
            .stream('p1', { type: 'spawn', id: 'p1', command: 'claude', args: [], env: {} }, message => seen.push(message.type));
        await eventually(() => seen.includes('out'));
        worker.socket.terminate();

        await eventually(() => seen.includes('exit'));
        expect(seen).toEqual(['out', 'exit']);
    });
});

describe('the passthrough list', () => {
    it('is the same on a worker as for a stage command here and over SSH', () => {
        expect([...PASSED_THROUGH_ENV]).toEqual(PASSED_THROUGH);
    });
});
