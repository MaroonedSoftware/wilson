import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

/**
 * A minimal client for `codex app-server`, for the engine probes only: JSON-RPC over stdio, one JSON
 * object per line, with no `"jsonrpc"` field. Shapes follow what `codex app-server generate-ts`
 * printed for codex-cli 0.166.0, and are typed loosely here on purpose: the probes exist to find out
 * what the engine actually does, so nothing is assumed beyond the method names.
 */

/** A request the server sends the client, such as an approval. */
export interface ServerRequest {
    id: number | string;
    method: string;
    params: Record<string, unknown>;
}

export interface ServerNotification {
    method: string;
    params: Record<string, unknown>;
}

export type ServerRequestHandler = (request: ServerRequest) => unknown;

export interface CodexAppServerOptions {
    /** The `codex` binary. */
    binary: string;
    /** A throwaway `CODEX_HOME`, so nothing reads or writes the operator's own. */
    codexHome: string;
    /** Added to a minimal environment, such as `CODEX_API_KEY`. */
    env?: Record<string, string>;
    /** Answers each server request. The default declines, which is the safe answer to an approval. */
    onRequest?: ServerRequestHandler;
}

export class CodexAppServer {
    readonly requests: ServerRequest[] = [];
    readonly notifications: ServerNotification[] = [];
    stderr = '';

    private nextId = 1;
    private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    private readonly listeners = new Set<(notification: ServerNotification) => void>();

    private constructor(
        private readonly child: ChildProcessWithoutNullStreams,
        private onRequest: ServerRequestHandler,
    ) {
        createInterface({ input: child.stdout }).on('line', line => this.receive(line));
        child.stderr.on('data', (chunk: Buffer) => (this.stderr = (this.stderr + chunk.toString()).slice(-8000)));
        child.on('exit', () => {
            for (const { reject } of this.pending.values()) reject(new Error(`codex app-server exited: ${this.stderr}`));
            this.pending.clear();
        });
    }

    /** Start the server and complete the `initialize` handshake. */
    static async start(options: CodexAppServerOptions): Promise<CodexAppServer> {
        const child = spawn(options.binary, ['app-server'], {
            env: {
                PATH: process.env.PATH ?? '/usr/bin:/bin',
                HOME: options.codexHome,
                CODEX_HOME: options.codexHome,
                ...options.env,
            },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        const server = new CodexAppServer(child, options.onRequest ?? decline);
        await server.request('initialize', {
            clientInfo: { name: 'wilson-probe', title: null, version: '0.0.0' },
            capabilities: { experimentalApi: false, requestAttestation: false },
        });
        server.notify('initialized');
        return server;
    }

    /** Replace how server requests are answered, for the next turn. */
    answerWith(handler: ServerRequestHandler): void {
        this.onRequest = handler;
    }

    request<T = Record<string, unknown>>(method: string, params: unknown = {}): Promise<T> {
        const id = this.nextId++;
        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, { resolve: value => resolve(value as T), reject });
            this.send({ id, method, params });
        });
    }

    notify(method: string, params?: unknown): void {
        this.send(params === undefined ? { method } : { method, params });
    }

    /** The next notification named `method` that `matches`, or a rejection after `timeoutMs`. */
    waitFor(method: string, matches: (params: Record<string, unknown>) => boolean, timeoutMs: number): Promise<Record<string, unknown>> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.listeners.delete(listener);
                reject(new Error(`no ${method} within ${timeoutMs}ms; stderr: ${this.stderr}`));
            }, timeoutMs);
            const listener = (notification: ServerNotification) => {
                if (notification.method !== method || !matches(notification.params)) return;
                clearTimeout(timer);
                this.listeners.delete(listener);
                resolve(notification.params);
            };
            this.listeners.add(listener);
        });
    }

    close(): void {
        this.child.kill();
    }

    private send(message: unknown): void {
        this.child.stdin.write(`${JSON.stringify(message)}\n`);
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
            this.requests.push(request);
            void Promise.resolve(this.onRequest(request)).then(
                result => this.send({ id: request.id, result }),
                (error: Error) => this.send({ id: request.id, error: { code: -32000, message: error.message } }),
            );
            return;
        }
        if (message.method !== undefined) {
            const notification = { method: message.method, params: message.params ?? {} };
            this.notifications.push(notification);
            for (const listener of [...this.listeners]) listener(notification);
            return;
        }
        const pending = typeof message.id === 'number' ? this.pending.get(message.id) : undefined;
        if (!pending) return;
        this.pending.delete(message.id as number);
        if (message.error) pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
        else pending.resolve(message.result);
    }
}

/** Decline an approval, and refuse anything else the probes did not ask for. */
export const decline: ServerRequestHandler = request => {
    if (request.method.endsWith('requestApproval')) return { decision: 'decline' };
    throw new Error(`the probe does not answer ${request.method}`);
};

/** What one turn did: the items it completed, and the approvals it asked for. */
export interface TurnRecord {
    status: string;
    error?: unknown;
    items: Array<Record<string, unknown>>;
    approvals: ServerRequest[];
    finalMessage?: string;
}

/** Start a thread in `cwd` and run one turn of `prompt` to completion. */
export const runTurn = async (
    server: CodexAppServer,
    options: {
        cwd: string;
        prompt: string;
        approvalPolicy: unknown;
        sandboxPolicy: unknown;
        model?: string;
        outputSchema?: unknown;
        timeoutMs?: number;
    },
): Promise<TurnRecord> => {
    const { thread } = await server.request<{ thread: { id: string } }>('thread/start', {
        cwd: options.cwd,
        approvalPolicy: options.approvalPolicy,
        ephemeral: true,
        ...(options.model && { model: options.model }),
    });
    const requestsBefore = server.requests.length;
    const notificationsBefore = server.notifications.length;
    const completed = server.waitFor('turn/completed', params => params.threadId === thread.id, options.timeoutMs ?? 180_000);
    await server.request('turn/start', {
        threadId: thread.id,
        input: [{ type: 'text', text: options.prompt, text_elements: [] }],
        approvalPolicy: options.approvalPolicy,
        sandboxPolicy: options.sandboxPolicy,
        ...(options.outputSchema !== undefined && { outputSchema: options.outputSchema }),
    });
    const { turn } = (await completed) as { turn: { status: string; error?: unknown } };
    const items = server.notifications
        .slice(notificationsBefore)
        .filter(notification => notification.method === 'item/completed' && notification.params.threadId === thread.id)
        .map(notification => notification.params.item as Record<string, unknown>);
    const approvals = server.requests.slice(requestsBefore).filter(request => request.params.threadId === thread.id);
    const messages = items.filter(item => item.type === 'agentMessage').map(item => String(item.text));
    return { status: turn.status, error: turn.error, items, approvals, finalMessage: messages.at(-1) };
};

/**
 * The tool items that ran without an approval request naming them. A declined item was asked about by
 * definition; an item still in progress at the end never ran.
 */
export const ranWithoutApproval = (record: TurnRecord): Array<Record<string, unknown>> => {
    const asked = new Set(record.approvals.map(request => request.params.itemId));
    return record.items.filter(
        item => (item.type === 'commandExecution' || item.type === 'fileChange') && item.status !== 'declined' && !asked.has(item.id),
    );
};
