import { WebSocket } from 'ws';
import {
    parseFrame,
    ToWorker,
    WORKER_CONNECT_PATH,
    WORKER_KEEPALIVE_MS,
    WORKER_PROTOCOL_VERSION,
    WorkerCloseCode,
    type FromWorker,
} from '@wilson/worker-protocol';
import { WorkerExecutor, type WorkerExecutorOptions } from './worker.executor.js';
import { ProjectRoots } from './worker.roots.js';

/** The largest single message accepted from Wilson: a git bundle carrying a card's base arrives as one. */
const MAX_PAYLOAD_BYTES = 256 * 1024 * 1024;

export interface WorkerLogger {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
}

export interface WorkerClientOptions {
    /** Wilson's API, as `http(s)://host:port`. The worker connects to its {@link WORKER_CONNECT_PATH}. */
    url: string;
    /** The host's worker token, from `wilson host token <name>`. */
    token: string;
    /** This program's version, said in every `hello`. */
    version: string;
    /** For the executor: the environment and engine binary to use. The path checks are this client's own. */
    executor?: Omit<WorkerExecutorOptions, 'checkPath' | 'checkCwd'>;
    logger?: WorkerLogger;
    /** The wait before the first reconnect, doubling to `maxReconnectMs`. */
    minReconnectMs?: number;
    maxReconnectMs?: number;
    /** How long a connection may stay silent before it counts as gone. A test shortens it. */
    silenceLimitMs?: number;
}

/**
 * How long a connection may stay silent before it counts as gone. Three of Wilson's pings, so one lost
 * in passing or a Wilson busy for a moment costs no stage, and a network cut that closes nothing is
 * still found within a minute rather than whenever traffic happens to return.
 */
const SILENCE_LIMIT_MS = 3 * WORKER_KEEPALIVE_MS;

/** Wilson's API URL as the WebSocket URL of its worker endpoint. */
export const connectUrl = (api: string): string => {
    const url = new URL(WORKER_CONNECT_PATH, api);
    if (url.protocol === 'http:') url.protocol = 'ws:';
    else if (url.protocol === 'https:') url.protocol = 'wss:';
    else throw new Error(`WILSON_URL must be an http or https URL, got "${api}"`);
    return url.toString();
};

/**
 * Why a worker stopped for good rather than reconnecting: trying again unchanged would fail the same
 * way, so it is reported and left for a person.
 */
export class WorkerStoppedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'WorkerStoppedError';
    }
}

/**
 * A worker's connection to Wilson, kept open: connect, say hello, carry out whatever arrives, and
 * reconnect with backoff whenever the connection drops. Each connection gets a fresh executor, and a
 * drop ends every process the last one started and everything those started, since the stage that
 * wanted them can no longer hear them and will be retried.
 *
 * Wilson pings every connection, and one that stops being heard from is closed here as a drop would
 * be. A network cut can close nothing, and without this the worker would sit on a dead socket, with its
 * engines still running and no way for Wilson to reach it, for as long as the cut lasts.
 *
 * It stops for good only when reconnecting cannot help: the token is refused (401), Wilson does not
 * speak this protocol version, or another worker has connected as the same host.
 */
export class WorkerClient {
    private socket?: WebSocket;
    private executor?: WorkerExecutor;
    private readonly roots = new ProjectRoots();
    private stopping = false;
    private retryTimer?: NodeJS.Timeout;
    private delay: number;
    private readonly logger: WorkerLogger;
    private settle?: { resolve: () => void; reject: (err: Error) => void };
    private warnedPlaintext = false;
    /** The host this worker was welcomed as, once it has been. */
    host?: string;

    constructor(private readonly options: WorkerClientOptions) {
        this.delay = options.minReconnectMs ?? 1_000;
        this.logger = options.logger ?? { info: () => {}, warn: () => {}, error: () => {} };
    }

    /**
     * Connect, and keep connecting. Resolves when {@link stop} is called; rejects with
     * {@link WorkerStoppedError} when Wilson refuses this worker in a way reconnecting cannot fix.
     */
    run(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.settle = { resolve, reject };
            this.connect();
        });
    }

    /** Resolves once Wilson has welcomed this worker on the current connection. */
    async welcomed(): Promise<string> {
        while (!this.host) await new Promise(resolve => setTimeout(resolve, 10));
        return this.host;
    }

    /**
     * Close the connection, end every process it started, and stop reconnecting. `run` resolves only
     * once those have had their last signal, since they are in process groups of their own and would
     * outlive a worker that exited first.
     */
    stop(): void {
        this.stopping = true;
        if (this.retryTimer) clearTimeout(this.retryTimer);
        const ended = this.executor?.killAll() ?? Promise.resolve();
        this.socket?.close(1000, 'worker stopping');
        void ended.finally(() => this.settle?.resolve());
    }

    /** An engine token came over this connection. Once, since each engine start brings one. */
    private warnIfPlaintext(): void {
        if (this.warnedPlaintext || connectUrl(this.options.url).startsWith('wss:')) return;
        this.warnedPlaintext = true;
        this.logger.warn('Wilson sent an engine token over an unencrypted connection; use an https WILSON_URL unless this network is private');
    }

    private connect(): void {
        const silenceLimitMs = this.options.silenceLimitMs ?? SILENCE_LIMIT_MS;
        const socket = new WebSocket(connectUrl(this.options.url), {
            headers: { authorization: `Bearer ${this.options.token}` },
            maxPayload: MAX_PAYLOAD_BYTES,
            handshakeTimeout: silenceLimitMs,
        });
        this.socket = socket;
        let silence: NodeJS.Timeout | undefined;
        const heard = (): void => {
            clearTimeout(silence);
            silence = setTimeout(() => {
                this.logger.warn(`heard nothing from Wilson in ${silenceLimitMs}ms; treating the connection as dropped`);
                socket.terminate();
            }, silenceLimitMs);
            silence.unref();
        };
        const executor = new WorkerExecutor(message => this.send(socket, message), {
            ...this.options.executor,
            checkPath: this.roots.checkPath,
            checkCwd: this.roots.checkCwd,
        });
        this.executor = executor;

        socket.on('ping', heard);
        socket.on('open', () => {
            heard();
            this.send(socket, { type: 'hello', protocol: WORKER_PROTOCOL_VERSION, workerVersion: this.options.version, platform: process.platform });
        });
        socket.on('message', (data, isBinary) => {
            heard();
            if (isBinary) return;
            const message = parseFrame(ToWorker, data.toString());
            if (!message) return;
            if (message.type === 'welcome') {
                this.roots.update(message.projects);
                if (this.host !== message.host) this.logger.info(`connected to Wilson as host ${message.host}`);
                this.host = message.host;
                this.delay = this.options.minReconnectMs ?? 1_000;
                return;
            }
            if ('engineToken' in message && message.engineToken !== undefined) this.warnIfPlaintext();
            executor.handle(message);
        });
        socket.on('unexpected-response', (_request, response) => {
            if (response.statusCode === 401) {
                this.fail('Wilson refused this worker’s token; mint a new one with `wilson host token <name>` and set WILSON_WORKER_TOKEN');
            } else {
                this.logger.warn(`Wilson answered the connection with HTTP ${response.statusCode}`);
            }
            socket.terminate();
        });
        socket.on('error', err => {
            this.logger.warn(`connection error: ${err.message}`);
        });
        socket.on('close', (code, reason) => {
            clearTimeout(silence);
            void executor.killAll();
            this.host = undefined;
            if (this.stopping) return;
            if (code === WorkerCloseCode.BadHello) {
                this.fail(`Wilson closed the connection: ${reason.toString() || 'it did not accept this worker’s hello'}`);
                return;
            }
            if (code === WorkerCloseCode.Superseded) {
                this.fail('another worker connected as the same host, so this one stopped; run one worker per host');
                return;
            }
            this.logger.warn(
                `disconnected from Wilson (${code}${reason.length > 0 ? `: ${reason.toString()}` : ''}); reconnecting in ${this.delay}ms`,
            );
            this.retryTimer = setTimeout(() => this.connect(), this.delay);
            this.delay = Math.min(this.delay * 2, this.options.maxReconnectMs ?? 30_000);
        });
    }

    private send(socket: WebSocket, message: FromWorker): void {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    }

    private fail(message: string): void {
        if (this.stopping) return;
        this.stopping = true;
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.logger.error(message);
        this.settle?.reject(new WorkerStoppedError(message));
    }
}
