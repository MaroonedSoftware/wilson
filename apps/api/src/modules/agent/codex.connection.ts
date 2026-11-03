import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

/** The part of a child process this reads: a real one, or whatever a host starts in its place. */
export interface CodexProcess {
    stdin: Writable;
    stdout: Readable;
    stderr: Readable;
    on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
    on(event: 'error', listener: (error: Error) => void): unknown;
    kill(signal?: NodeJS.Signals): unknown;
}

/** A request the server sends the client, such as an approval. */
export interface CodexServerRequest {
    id: number | string;
    method: string;
    params: Record<string, unknown>;
}

export interface CodexNotification {
    method: string;
    params: Record<string, unknown>;
}

/** How the process ended, or never started. */
export interface CodexExit {
    code: number | null;
    signal: NodeJS.Signals | null;
    error?: Error;
}

export interface CodexConnectionHandlers {
    /** Answers a server request. A rejection reaches the server as an error response. */
    onRequest: (request: CodexServerRequest) => unknown;
    onNotification?: (notification: CodexNotification) => void;
}

const STDERR_TAIL_CHARS = 8000;

/**
 * JSON-RPC to `codex app-server` over stdio: one JSON object per line, with no `"jsonrpc"` field.
 * Method names and shapes follow `codex app-server generate-ts --experimental` for codex-cli 0.166.0.
 */
export class CodexConnection {
    /** Resolves once the process has ended, whichever way. Never rejects. */
    readonly closed: Promise<CodexExit>;
    stderr = '';

    private nextId = 1;
    private ended = false;
    private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

    constructor(
        private readonly child: CodexProcess,
        private readonly handlers: CodexConnectionHandlers,
    ) {
        createInterface({ input: child.stdout }).on('line', line => this.receive(line));
        child.stderr.on('data', (chunk: Buffer | string) => {
            this.stderr = (this.stderr + chunk.toString()).slice(-STDERR_TAIL_CHARS);
        });
        // A write to a process that has gone is reported by `closed`, and would otherwise be unhandled.
        child.stdin.on('error', () => {});
        this.closed = new Promise(resolve => {
            const end = (exit: CodexExit) => {
                if (this.ended) return;
                this.ended = true;
                const message = `codex app-server exited${exit.error ? `: ${exit.error.message}` : ''}${this.stderr ? `; stderr: ${this.stderr}` : ''}`;
                for (const { reject } of this.pending.values()) reject(new Error(message));
                this.pending.clear();
                resolve(exit);
            };
            child.on('exit', (code, signal) => end({ code, signal }));
            child.on('error', error => end({ code: null, signal: null, error }));
        });
    }

    /** The `initialize` handshake. `experimentalApi` is what `thread/start`'s `dynamicTools` needs. */
    async initialize(clientName: string, experimentalApi: boolean): Promise<void> {
        await this.request('initialize', {
            clientInfo: { name: clientName, title: null, version: '0.0.0' },
            capabilities: { experimentalApi, requestAttestation: false },
        });
        this.notify('initialized');
    }

    request<T = Record<string, unknown>>(method: string, params: unknown = {}): Promise<T> {
        if (this.ended) return Promise.reject(new Error(`codex app-server has exited; could not send ${method}`));
        const id = this.nextId++;
        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, { resolve: value => resolve(value as T), reject });
            this.send({ id, method, params });
        });
    }

    notify(method: string, params?: unknown): void {
        this.send(params === undefined ? { method } : { method, params });
    }

    close(): void {
        this.child.kill();
    }

    private send(message: unknown): void {
        if (!this.ended) this.child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    private receive(line: string): void {
        let message: { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string } };
        try {
            message = JSON.parse(line);
        } catch {
            return;
        }
        if (message.method !== undefined && message.id !== undefined) {
            const request = { id: message.id, method: message.method, params: message.params ?? {} };
            void Promise.resolve()
                .then(() => this.handlers.onRequest(request))
                .then(
                    result => this.send({ id: request.id, result }),
                    (error: Error) => this.send({ id: request.id, error: { code: -32000, message: error.message } }),
                );
            return;
        }
        if (message.method !== undefined) {
            this.handlers.onNotification?.({ method: message.method, params: message.params ?? {} });
            return;
        }
        const pending = typeof message.id === 'number' ? this.pending.get(message.id) : undefined;
        if (!pending) return;
        this.pending.delete(message.id as number);
        if (message.error) pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
        else pending.resolve(message.result);
    }
}
