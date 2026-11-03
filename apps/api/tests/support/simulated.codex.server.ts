import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

interface Message {
    id?: number | string;
    method?: string;
    params?: Record<string, unknown>;
    result?: unknown;
    error?: { message?: string };
}

/**
 * A stand-in for `codex app-server`, shaped by `codex app-server generate-ts` for codex-cli 0.166.0
 * and by no real run: it shows what the adapter does with the protocol as documented, not that the
 * engine behaves as documented. That is `codex.engine.contract.probe.ts`'s job.
 *
 * A test scripts a turn as an async function, called on `turn/start`.
 */
export class SimulatedCodexServer extends EventEmitter {
    readonly stdin = new PassThrough();
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    /** Every request the adapter sent, in order. */
    readonly received: { method: string; params: Record<string, unknown> }[] = [];
    killed = false;
    threadId = 'thread-1';
    turnId = 'turn-1';
    /** A method to answer with an error, by method name. */
    failing = new Map<string, string>();
    /** Answers nothing, as a process that never really started. */
    deaf = false;

    private nextId = 1000;
    private readonly answers = new Map<number, (message: Message) => void>();

    constructor(private readonly turn: (server: SimulatedCodexServer) => Promise<unknown> = async server => server.completeTurn()) {
        super();
        createInterface({ input: this.stdin }).on('line', line => this.receive(JSON.parse(line) as Message));
    }

    /** What `spawnCodex` returns. */
    get process(): ChildProcessWithoutNullStreams {
        return this as unknown as ChildProcessWithoutNullStreams;
    }

    kill(): boolean {
        this.killed = true;
        return true;
    }

    /** The process ending on its own. */
    exit(code: number | null, signal: NodeJS.Signals | null = null): void {
        this.emit('exit', code, signal);
    }

    notify(method: string, params: Record<string, unknown>): void {
        this.stdout.write(`${JSON.stringify({ method, params: { threadId: this.threadId, turnId: this.turnId, ...params } })}\n`);
    }

    /** A server request, resolving to the adapter's answer. */
    ask(method: string, params: Record<string, unknown>): Promise<Message> {
        const id = this.nextId++;
        return new Promise(resolve => {
            this.answers.set(id, resolve);
            this.stdout.write(`${JSON.stringify({ id, method, params: { threadId: this.threadId, turnId: this.turnId, ...params } })}\n`);
        });
    }

    /** One command: started, asked about, then completed or declined by what the adapter answered. */
    async runCommand(id: string, command: string, cwd?: string): Promise<string> {
        this.notify('item/started', { item: { type: 'commandExecution', id, command, status: 'inProgress' } });
        const answer = await this.ask('item/commandExecution/requestApproval', { itemId: id, kind: 'command', command, ...(cwd && { cwd }) });
        const decision = String((answer.result as { decision?: unknown } | undefined)?.decision);
        this.notify('item/completed', { item: { type: 'commandExecution', id, command, status: decision === 'accept' ? 'completed' : 'declined' } });
        return decision;
    }

    /** One patch, the same way. */
    async changeFiles(id: string, changes: { path: string; kind?: unknown }[]): Promise<string> {
        const item = { type: 'fileChange', id, changes: changes.map(change => ({ kind: { type: 'update', move_path: null }, diff: '', ...change })) };
        this.notify('item/started', { item: { ...item, status: 'inProgress' } });
        const answer = await this.ask('item/fileChange/requestApproval', { itemId: id });
        const decision = String((answer.result as { decision?: unknown } | undefined)?.decision);
        this.notify('item/completed', { item: { ...item, status: decision === 'accept' ? 'completed' : 'declined' } });
        return decision;
    }

    async callTool(tool: string, args: unknown): Promise<{ text?: string; success?: boolean }> {
        this.notify('item/started', { item: { type: 'dynamicToolCall', id: `call-${tool}`, tool, status: 'inProgress' } });
        const answer = await this.ask('item/tool/call', { callId: `call-${tool}`, namespace: null, tool, arguments: args });
        const result = answer.result as { contentItems?: { text?: string }[]; success?: boolean } | undefined;
        return { text: result?.contentItems?.[0]?.text, success: result?.success };
    }

    completeTurn(status = 'completed', error?: unknown): void {
        this.stdout.write(
            `${JSON.stringify({ method: 'turn/completed', params: { threadId: this.threadId, turn: { id: this.turnId, status, error: error ?? null, items: [] } } })}\n`,
        );
    }

    private receive(message: Message): void {
        if (this.deaf) return;
        if (message.method === undefined) {
            this.answers.get(message.id as number)?.(message);
            return;
        }
        if (message.id === undefined) return;
        const method = message.method;
        this.received.push({ method, params: message.params ?? {} });
        const failure = this.failing.get(method);
        if (failure !== undefined) {
            this.stdout.write(`${JSON.stringify({ id: message.id, error: { code: -32600, message: failure } })}\n`);
            return;
        }
        const result =
            method === 'thread/start' || method === 'thread/resume'
                ? { thread: { id: this.threadId } }
                : method === 'turn/start'
                  ? { turn: { id: this.turnId, status: 'inProgress', items: [] } }
                  : {};
        this.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`);
        if (method === 'turn/start') void this.turn(this);
    }
}
