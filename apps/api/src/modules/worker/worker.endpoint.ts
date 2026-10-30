import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Logger } from '@maroonedsoftware/logger';
import { FromWorker, parseFrame, WORKER_CONNECT_PATH, WORKER_PROTOCOL_VERSION, WorkerCloseCode, type ToWorker } from '@wilson/worker-protocol';
import type { HostRow } from '#modules/host/host.repository.js';
import { WorkerConnection } from './worker.connection.js';
import type { WorkerConnections } from './worker.connections.js';

/** How long a worker has, once connected, to send its `hello`. */
const HELLO_TIMEOUT_MS = 10_000;

/**
 * The largest single message accepted from a worker. A file read or a command's output arrives as one
 * message, and `exec`'s own default cap is far below this; it bounds what a misbehaving worker can make
 * this process buffer.
 */
const MAX_PAYLOAD_BYTES = 256 * 1024 * 1024;

export interface WorkerEndpointOptions {
    /** The worker host a token connects as, or undefined when it may not connect (`WorkerTokensService.authenticate`). */
    authenticate: (token: string) => Promise<HostRow | undefined>;
    connections: WorkerConnections;
    logger: Pick<Logger, 'info' | 'warn'>;
    /** Told each host whose worker has just connected, once its connection is registered. */
    onConnect?: (hostName: string) => void;
    /** Aborted when the server shuts down, closing every worker connection. */
    signal?: AbortSignal;
    helloTimeoutMs?: number;
}

/** Refuse an upgrade before it becomes a WebSocket, with a plain HTTP status. */
const refuse = (socket: Duplex, status: string): void => {
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
};

/**
 * Accept worker connections on `server`, at {@link WORKER_CONNECT_PATH}.
 *
 * Not a ContractKit route: a WebSocket starts as an HTTP upgrade, which Koa never sees. That is also
 * why it does its own authentication, and why that is deliberately narrower than the API's: the only
 * credential accepted is a worker token (`Authorization: Bearer`), which names exactly one worker host
 * that is enabled, and an account session or API key is refused here just as a worker token is refused
 * everywhere else.
 *
 * After the upgrade the worker must say `hello` with this protocol version within
 * `helloTimeoutMs`; Wilson answers `welcome` with the host's name and projects, and from then the
 * connection is the host's until it closes or another replaces it.
 */
export const attachWorkerEndpoint = (server: Server, options: WorkerEndpointOptions): WebSocketServer => {
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
    const helloTimeoutMs = options.helloTimeoutMs ?? HELLO_TIMEOUT_MS;

    server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
        void upgrade(request, socket, head);
    });

    const upgrade = async (request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> => {
        const path = new URL(request.url ?? '/', 'http://wilson').pathname;
        if (path !== WORKER_CONNECT_PATH) return refuse(socket, '404 Not Found');

        const header = request.headers.authorization ?? '';
        const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
        const host = token ? await options.authenticate(token).catch(() => undefined) : undefined;
        if (!host) {
            options.logger.warn(`refused a worker connection from ${request.socket.remoteAddress ?? 'an unknown address'}: no valid worker token`);
            return refuse(socket, '401 Unauthorized');
        }

        wss.handleUpgrade(request, socket, head, ws => greet(ws, host));
    };

    const greet = (ws: WebSocket, host: HostRow): void => {
        const timer = setTimeout(() => ws.close(WorkerCloseCode.BadHello, `no hello in ${helloTimeoutMs}ms`), helloTimeoutMs);
        ws.once('message', (data, isBinary) => {
            clearTimeout(timer);
            const hello = isBinary ? undefined : parseFrame(FromWorker, data.toString());
            if (hello?.type !== 'hello') {
                ws.close(WorkerCloseCode.BadHello, 'the first message must be a hello');
                return;
            }
            if (hello.protocol !== WORKER_PROTOCOL_VERSION) {
                ws.close(WorkerCloseCode.BadHello, `this server speaks worker protocol ${WORKER_PROTOCOL_VERSION}, not ${hello.protocol}`);
                return;
            }

            const connection = new WorkerConnection(host.name, { workerVersion: hello.workerVersion, platform: hello.platform }, ws);
            const welcome: ToWorker = { type: 'welcome', host: host.name, projects: host.projects };
            ws.send(JSON.stringify(welcome));
            options.connections.register(connection);
            options.logger.info(`worker for host ${host.name} connected (worker ${hello.workerVersion} on ${hello.platform})`);
            connection.onClose(reason => options.logger.info(`worker for host ${host.name} disconnected: ${reason}`));
            options.onConnect?.(host.name);
        });
    };

    options.signal?.addEventListener('abort', () => {
        options.connections.closeAll('the server is shutting down');
        wss.close();
    });

    return wss;
};
