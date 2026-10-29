import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { WorkerClient, type WorkerClientOptions } from '@wilson/worker';
import { FromWorker, ToWorker, WORKER_CONNECT_PATH, WORKER_PROTOCOL_VERSION, parseFrame } from '@wilson/worker-protocol';
import type { HostRow } from '#modules/host/host.repository.js';
import { WorkerConnections } from '#modules/worker/worker.connections.js';
import { attachWorkerEndpoint } from '#modules/worker/worker.endpoint.js';

/** A worker host row as `authenticate` would return one. */
export const workerRow = (name: string, projects: HostRow['projects'] = []): HostRow => ({
    name,
    kind: 'worker',
    slots: 1,
    enabled: true,
    draining: false,
    commandEnv: [],
    projects,
    running: [],
});

/**
 * A real HTTP server with the worker endpoint attached, on a free port, accepting the tokens in
 * `tokens` as the hosts they map to.
 */
export const startWorkerServer = async (
    tokens: Record<string, HostRow>,
    options: { helloTimeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{ server: Server; url: string; apiUrl: string; connections: WorkerConnections; close: () => Promise<void> }> => {
    const server = createServer((_req, res) => res.writeHead(404).end());
    const connections = new WorkerConnections();
    attachWorkerEndpoint(server, {
        authenticate: async token => tokens[token],
        connections,
        logger: { info: () => {}, warn: () => {} },
        ...options,
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
        server,
        url: `ws://127.0.0.1:${port}${WORKER_CONNECT_PATH}`,
        apiUrl: `http://127.0.0.1:${port}`,
        connections,
        close: async () => {
            connections.closeAll('test over');
            await new Promise<void>(resolve => server.close(() => resolve()));
        },
    };
};

/**
 * A stand-in worker: connects with `token`, says hello, and hands every message Wilson sends to
 * `answer`, which may reply with `send`. Real `ws` on both ends; only the work is pretend.
 */
export class FakeWorker {
    readonly received: ToWorker[] = [];
    welcome?: Extract<ToWorker, { type: 'welcome' }>;
    private readonly closeCode: Promise<number>;
    private constructor(readonly socket: WebSocket) {
        // Listened for from the start, so a close that lands before a test asks is still seen.
        this.closeCode = new Promise(resolve => socket.once('close', code => resolve(code)));
    }

    static async connect(
        url: string,
        token: string | undefined,
        answer: (message: ToWorker, worker: FakeWorker) => void = () => {},
        hello: object = { type: 'hello', protocol: WORKER_PROTOCOL_VERSION, workerVersion: '0.0.1-test', platform: 'linux' },
    ): Promise<FakeWorker> {
        const socket = new WebSocket(url, token ? { headers: { authorization: `Bearer ${token}` } } : {});
        const worker = new FakeWorker(socket);
        await new Promise<void>((resolve, reject) => {
            socket.once('open', () => resolve());
            socket.once('unexpected-response', (_req, res) => reject(new Error(`refused with ${res.statusCode}`)));
            socket.once('error', reject);
        });
        socket.on('message', data => {
            const message = parseFrame(ToWorker, data.toString());
            if (!message) return;
            if (message.type === 'welcome') worker.welcome = message;
            worker.received.push(message);
            answer(message, worker);
        });
        socket.send(JSON.stringify(hello));
        return worker;
    }

    send(message: FromWorker): void {
        this.socket.send(JSON.stringify(message));
    }

    /** Resolves with the close code once Wilson closes the connection. */
    closed(): Promise<number> {
        return this.closeCode;
    }
}

/** Wait until `check` holds, polling briefly: for state another socket's event will set. */
export const eventually = async (check: () => boolean, timeoutMs = 2_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() > deadline) throw new Error('condition not met in time');
        await new Promise(resolve => setTimeout(resolve, 10));
    }
};

/**
 * The worker program itself, connected to `apiUrl` as the host `token` names: its own `WorkerClient`,
 * executor and project-roots check, so what Wilson is tested against is what a worker really does.
 * Resolves once Wilson has welcomed it; `stop()` disconnects it.
 */
export const connectLoopbackWorker = async (apiUrl: string, token: string, executor: WorkerClientOptions['executor'] = {}): Promise<WorkerClient> => {
    const client = new WorkerClient({ url: apiUrl, token, version: '0.0.1-test', executor, minReconnectMs: 20, maxReconnectMs: 100 });
    void client.run().catch(() => undefined);
    await client.welcomed();
    return client;
};
