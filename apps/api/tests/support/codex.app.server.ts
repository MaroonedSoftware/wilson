import { spawn } from 'node:child_process';
import { CodexConnection, type CodexNotification, type CodexServerRequest } from '#modules/agent/codex.connection.js';

/**
 * `codex app-server` for the engine probes only, over the adapter's own `CodexConnection`, which
 * started here. It keeps every request and notification, for a probe to look through afterwards, and
 * is typed loosely on purpose: the probes exist to find out what the engine actually does, so nothing
 * is assumed beyond the method names.
 */

/** A request the server sends the client, such as an approval. */
export type ServerRequest = CodexServerRequest;
export type ServerNotification = CodexNotification;

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

    private readonly connection: CodexConnection;
    private readonly listeners = new Set<(notification: ServerNotification) => void>();

    private constructor(options: CodexAppServerOptions) {
        let onRequest = options.onRequest ?? decline;
        this.answerWith = handler => {
            onRequest = handler;
        };
        const child = spawn(options.binary, ['app-server'], {
            env: {
                PATH: process.env.PATH ?? '/usr/bin:/bin',
                HOME: options.codexHome,
                CODEX_HOME: options.codexHome,
                ...options.env,
            },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        this.connection = new CodexConnection(child, {
            onRequest: request => {
                this.requests.push(request);
                return onRequest(request);
            },
            onNotification: notification => {
                this.notifications.push(notification);
                for (const listener of [...this.listeners]) listener(notification);
            },
        });
    }

    /** Start the server and complete the `initialize` handshake. */
    static async start(options: CodexAppServerOptions): Promise<CodexAppServer> {
        const server = new CodexAppServer(options);
        await server.connection.initialize('wilson-probe', false);
        return server;
    }

    /** Replace how server requests are answered, for the next turn. */
    readonly answerWith: (handler: ServerRequestHandler) => void;

    get stderr(): string {
        return this.connection.stderr;
    }

    request<T = Record<string, unknown>>(method: string, params: unknown = {}): Promise<T> {
        return this.connection.request<T>(method, params);
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
        this.connection.close();
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
