import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { parseFrame, FromWorker, type CallOp, type CallResults, type ToWorker, type WorkerError } from '@wilson/worker-protocol';
import type { ExecFailure } from '#modules/host/execution.host.js';

/** What a worker said about itself in its `hello`. */
export interface WorkerHello {
    workerVersion: string;
    platform: string;
}

/** A spawned process's output or end, as the worker reports it. */
export type WorkerStreamMessage = Extract<FromWorker, { type: 'out' } | { type: 'exit' }>;

/** How often a connection is pinged, and how long a missing pong is tolerated: one interval. */
const KEEPALIVE_MS = 15_000;

/**
 * Rebuild the `execFile`-shaped failure a worker described, so callers handle a failure on a worker
 * exactly as they would one here or over SSH.
 */
export const toExecFailure = (error: WorkerError): ExecFailure => {
    const failure: ExecFailure = new Error(error.message);
    if (error.code !== undefined) failure.code = error.code;
    if (error.killed !== undefined) failure.killed = error.killed;
    if (error.stdout !== undefined) failure.stdout = error.stdout;
    if (error.stderr !== undefined) failure.stderr = error.stderr;
    return failure;
};

/**
 * Thrown for every call still waiting when a worker's connection closes, and for any call made after.
 * Its message avoids every pattern `isPermanentFailure` matches, as `HostLostError`'s does, so a stage
 * that hits it is retried rather than failed.
 */
export class WorkerConnectionLostError extends Error {
    constructor(
        readonly hostName: string,
        detail: string,
    ) {
        super(`the worker connection for host ${hostName} closed: ${detail}`);
        this.name = 'WorkerConnectionLostError';
    }
}

type Pending = { resolve: (value: unknown) => void; reject: (err: Error) => void; timer?: NodeJS.Timeout };

/**
 * One worker's live connection: the `call`s waiting on an answer, the processes it is streaming, and
 * the keepalive that notices when the other end has gone without saying so.
 *
 * Every message is routed by `id`, which Wilson chooses, so a worker cannot answer a call it was never
 * sent: an unknown id is ignored.
 */
export class WorkerConnection {
    private readonly pending = new Map<string, Pending>();
    private readonly streams = new Map<string, (message: WorkerStreamMessage) => void>();
    private closedWith?: string;
    private alive = true;
    private readonly keepalive: NodeJS.Timeout;
    private readonly closeListeners = new Set<(reason: string) => void>();

    constructor(
        readonly hostName: string,
        readonly hello: WorkerHello,
        private readonly socket: WebSocket,
    ) {
        socket.on('message', (data, isBinary) => {
            if (isBinary) return;
            this.receive(data.toString());
        });
        socket.on('pong', () => {
            this.alive = true;
        });
        socket.on('close', (code, reason) => this.closed(`closed with ${code}${reason.length > 0 ? ` (${reason.toString()})` : ''}`));
        socket.on('error', err => this.closed(err.message));
        this.keepalive = setInterval(() => {
            if (!this.alive) {
                socket.terminate();
                this.closed(`no answer to a keepalive ping in ${KEEPALIVE_MS / 1000}s`);
                return;
            }
            this.alive = false;
            socket.ping();
        }, KEEPALIVE_MS);
        this.keepalive.unref();
    }

    /** Whether this connection is still open. A closed one is never reopened; the worker connects anew. */
    get open(): boolean {
        return this.closedWith === undefined;
    }

    /**
     * Ask the worker to run one primitive, and wait for its answer. Rejects with the worker's failure,
     * rebuilt as an `ExecFailure`; with {@link WorkerConnectionLostError} if the connection closes
     * first; and, given `timeoutMs`, with a timeout if the worker does not answer in time.
     */
    call<K extends CallOp['op']>(call: Extract<CallOp, { op: K }>, timeoutMs?: number): Promise<CallResults[K]> {
        const id = randomUUID();
        return this.request(id, { type: 'call', id, call }, timeoutMs, `${call.op}`) as Promise<CallResults[K]>;
    }

    /** `claude` with `args` on the worker, started as a `spawn` would start it, and collected. */
    runClaude(args: string[], timeoutMs: number, engineToken?: string): Promise<CallResults['exec']> {
        const id = randomUUID();
        const message: ToWorker = { type: 'run-claude', id, args, timeoutMs, ...(engineToken !== undefined && { engineToken }) };
        // A little past the worker's own limit, so its timeout, which says more, arrives first.
        return this.request(id, message, timeoutMs + 5_000, 'claude') as Promise<CallResults['exec']>;
    }

    /**
     * Send `message` and route every `out` and `exit` for `id` to `listener` until the exit. If the
     * connection closes first, `listener` gets an `exit` carrying the reason, so a caller waiting on a
     * process always hears it end.
     */
    stream(id: string, message: ToWorker, listener: (message: WorkerStreamMessage) => void): void {
        if (this.closedWith !== undefined) {
            listener({
                type: 'exit',
                id,
                code: null,
                signal: null,
                error: { message: new WorkerConnectionLostError(this.hostName, this.closedWith).message },
            });
            return;
        }
        this.streams.set(id, listener);
        this.send(message);
    }

    /** Send one message, dropping it once the connection has closed: there is nobody to read it. */
    send(message: ToWorker): void {
        if (this.closedWith !== undefined) return;
        this.socket.send(JSON.stringify(message));
    }

    /** Called once, with the reason, when the connection closes. Immediately if it already has. */
    onClose(listener: (reason: string) => void): void {
        if (this.closedWith !== undefined) listener(this.closedWith);
        else this.closeListeners.add(listener);
    }

    /** Close the connection with `code`, failing everything still waiting on it. */
    close(code: number, reason: string): void {
        if (this.closedWith === undefined) this.socket.close(code, reason);
        this.closed(reason);
    }

    private request(id: string, message: ToWorker, timeoutMs: number | undefined, what: string): Promise<unknown> {
        if (this.closedWith !== undefined) return Promise.reject(new WorkerConnectionLostError(this.hostName, this.closedWith));
        return new Promise((resolve, reject) => {
            const timer =
                timeoutMs === undefined
                    ? undefined
                    : setTimeout(() => {
                          this.pending.delete(id);
                          reject(Object.assign(new Error(`${what} on worker ${this.hostName} did not answer in ${timeoutMs}ms`), { killed: true }));
                      }, timeoutMs);
            this.pending.set(id, { resolve, reject, ...(timer && { timer }) });
            this.send(message);
        });
    }

    private receive(raw: string): void {
        const message = parseFrame(FromWorker, raw);
        if (!message) return;
        if (message.type === 'result') {
            const waiting = this.pending.get(message.id);
            if (!waiting) return;
            this.pending.delete(message.id);
            if (waiting.timer) clearTimeout(waiting.timer);
            if (message.ok) waiting.resolve(message.value);
            else waiting.reject(toExecFailure(message.error));
        } else if (message.type === 'out' || message.type === 'exit') {
            const listener = this.streams.get(message.id);
            if (!listener) return;
            if (message.type === 'exit') this.streams.delete(message.id);
            listener(message);
        }
    }

    private closed(reason: string): void {
        if (this.closedWith !== undefined) return;
        this.closedWith = reason;
        clearInterval(this.keepalive);
        const lost = new WorkerConnectionLostError(this.hostName, reason);
        for (const [id, waiting] of this.pending) {
            if (waiting.timer) clearTimeout(waiting.timer);
            waiting.reject(lost);
            this.pending.delete(id);
        }
        for (const [id, listener] of this.streams) {
            this.streams.delete(id);
            listener({ type: 'exit', id, code: null, signal: null, error: { message: lost.message } });
        }
        for (const listener of this.closeListeners) listener(reason);
        this.closeListeners.clear();
    }
}
