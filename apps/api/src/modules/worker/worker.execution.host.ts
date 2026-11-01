import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ClaudeSpawnOptions, ExecOptions, ExecResult, ExecutionHost, HostStat } from '#modules/host/execution.host.js';
import { ENGINE_TOKEN_VARIABLE } from '@wilson/worker-protocol';
import { toExecFailure, type WorkerConnection, type WorkerStreamMessage } from './worker.connection.js';

/** How long a file primitive may take before it is treated as a lost connection, as on an SSH host. */
const FILE_OP_TIMEOUT_MS = 60_000;

/**
 * How long past a command's own `timeoutMs` to wait for the worker's answer. The worker kills the
 * command at its limit and answers with that; this only catches a worker that never answers at all.
 */
const EXEC_ANSWER_GRACE_MS = 30_000;

/** A little over the worker's own limit on a clone, so its answer arrives before this gives up. */
const CLONE_ANSWER_TIMEOUT_MS = 31 * 60_000;

/** An env as it travels: strings only, since `undefined` means unset and JSON would drop it anyway. */
const definedEnv = (env: NodeJS.ProcessEnv): Record<string, string> => {
    const defined: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) if (value !== undefined) defined[key] = value;
    return defined;
};

/** What this host's engines sign in with now: the token assigned to it, or undefined for the worker's own. */
export type EngineTokenResolver = () => Promise<string | undefined>;

/**
 * A machine whose worker program has connected in: every primitive is a message over its connection,
 * answered by the worker running the same `node:fs` or `execFile` call there.
 *
 * Mirrors `SshHost` in everything a caller can see: the same `ExecFailure` shapes (the worker sends
 * them back field for field), the same environment rules (`commandEnvironment` and
 * `engineEnvironment` in `@wilson/worker-protocol`, applied on the worker), and an engine whose stdio
 * comes back here, so the SDK's tool guard and callbacks still run in this process. Only the work moves.
 */
export class WorkerExecutionHost implements ExecutionHost {
    readonly name: string;

    constructor(
        private readonly connection: WorkerConnection,
        readonly commandEnv: readonly string[] = [],
        private readonly engineToken: EngineTokenResolver = async () => undefined,
    ) {
        this.name = `worker:${connection.hostName}`;
    }

    async readFile(path: string): Promise<string> {
        return this.connection.call({ op: 'readFile', path }, FILE_OP_TIMEOUT_MS);
    }

    async writeFile(path: string, content: string): Promise<void> {
        await this.connection.call({ op: 'writeFile', path, content }, FILE_OP_TIMEOUT_MS);
    }

    async mkdir(path: string): Promise<void> {
        await this.connection.call({ op: 'mkdir', path }, FILE_OP_TIMEOUT_MS);
    }

    async stat(path: string): Promise<HostStat> {
        return this.connection.call({ op: 'stat', path }, FILE_OP_TIMEOUT_MS);
    }

    async realpath(path: string): Promise<string> {
        return this.connection.call({ op: 'realpath', path }, FILE_OP_TIMEOUT_MS);
    }

    async copyFile(from: string, to: string): Promise<void> {
        await this.connection.call({ op: 'copyFile', from, to }, FILE_OP_TIMEOUT_MS);
    }

    async unlink(path: string): Promise<void> {
        await this.connection.call({ op: 'unlink', path }, FILE_OP_TIMEOUT_MS);
    }

    async removeTree(path: string): Promise<void> {
        await this.connection.call({ op: 'removeTree', path }, FILE_OP_TIMEOUT_MS);
    }

    async exec(file: string, args: readonly string[], options: ExecOptions): Promise<ExecResult> {
        return this.connection.call(
            {
                op: 'exec',
                file,
                args: [...args],
                options: {
                    cwd: options.cwd,
                    ...(options.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }),
                    ...(options.maxBuffer !== undefined && { maxBuffer: options.maxBuffer }),
                    ...(options.env && { env: definedEnv(options.env) }),
                    ...(options.hostEnv && { hostEnv: [...options.hostEnv] }),
                },
            },
            options.timeoutMs === undefined ? undefined : options.timeoutMs + EXEC_ANSWER_GRACE_MS,
        );
    }

    /**
     * Start `claude` on the worker for the Agent SDK's `spawnClaudeCodeProcess`. Only the SDK's own
     * variables travel, and the token this host is assigned, resolved now so a replaced one reaches
     * the next engine; the worker supplies its `PATH`, its home, and its own token if none is assigned.
     * A token in `options.env` is this machine's and stays here: the frame would carry it to a worker
     * that is not meant to have it, even though the worker drops it on arrival.
     *
     * The SDK needs the process back at once and the token takes a query to find, so the process
     * returned starts a moment later, holding back whatever the SDK writes until it has. A token that
     * cannot be read ends the process with that reason, on stderr, which is where a stage's failure
     * reads it from.
     *
     * The returned object is not a real `ChildProcess`: it is {@link WorkerEngineProcess}, which has
     * every member the SDK's `SpawnedProcess` reads (stdin, stdout, stderr, `killed`, `exitCode`,
     * `signalCode`, `kill`, and the `exit` and `error` events), cast to the type this interface names.
     */
    spawnClaude(options: ClaudeSpawnOptions): ChildProcess {
        const id = randomUUID();
        const env = { ...options.env };
        delete env[ENGINE_TOKEN_VARIABLE];
        const started = this.engineToken().then(
            engineToken =>
                this.connection.stream(
                    id,
                    {
                        type: 'spawn',
                        id,
                        command: options.command,
                        args: options.args,
                        ...(options.cwd && { cwd: options.cwd }),
                        env: definedEnv(env),
                        ...(engineToken !== undefined && { engineToken }),
                    },
                    message => engine.receive(message),
                ),
            (err: Error) => {
                engine.stderr.write(`${err.message}\n`);
                engine.receive({ type: 'exit', id, code: null, signal: null, error: { message: err.message } });
            },
        );
        const engine = new WorkerEngineProcess(this.connection, id, started);
        return engine as unknown as ChildProcess;
    }

    async runClaude(args: string[], timeoutMs: number): Promise<ExecResult> {
        return this.connection.runClaude(args, timeoutMs, await this.engineToken());
    }

    async cloneRepository(url: string, path: string, token: string): Promise<void> {
        await this.connection.call({ op: 'clone', url, path, token }, CLONE_ANSWER_TIMEOUT_MS);
    }
}

/**
 * The engine running on a worker, as the Agent SDK sees a process: stdin goes out over the connection,
 * and stdout, stderr and the exit come back from it. A connection that closes mid-run ends the process
 * with an exit carrying no code, as a killed process would, so the SDK hears it stop.
 */
export class WorkerEngineProcess extends EventEmitter {
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    readonly stdin: Writable;
    killed = false;
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;
    private ended = false;

    constructor(
        private readonly connection: WorkerConnection,
        private readonly id: string,
        private readonly started: Promise<void> = Promise.resolve(),
    ) {
        super();
        this.stdin = new Writable({
            write: (chunk: Buffer, _encoding, done) => {
                void started.then(() => {
                    connection.send({ type: 'stdin', id, data: Buffer.from(chunk).toString('base64') });
                    done();
                });
            },
            final: done => {
                void started.then(() => {
                    connection.send({ type: 'stdin-end', id });
                    done();
                });
            },
        });
    }

    kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
        if (this.ended) return false;
        this.killed = true;
        void this.started.then(() => this.connection.send({ type: 'kill', id: this.id, signal }));
        return true;
    }

    /** One `out` or `exit` from the worker for this process. */
    receive(message: WorkerStreamMessage): void {
        if (this.ended) return;
        if (message.type === 'out') {
            (message.stream === 'stdout' ? this.stdout : this.stderr).write(Buffer.from(message.data, 'base64'));
            return;
        }
        this.ended = true;
        this.exitCode = message.code;
        this.signalCode = (message.signal as NodeJS.Signals | null) ?? null;
        if (message.error) {
            if (message.code === null && message.signal === null) this.killed = true;
            // Only to a listener: an `error` event nobody listens for throws, and the exit below
            // already tells the SDK the process is gone.
            if (this.listenerCount('error') > 0) this.emit('error', toExecFailure(message.error));
        }
        this.stdout.end();
        this.stderr.end();
        this.emit('exit', this.exitCode, this.signalCode);
        this.emit('close', this.exitCode, this.signalCode);
    }
}
