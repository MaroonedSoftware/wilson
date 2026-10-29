import { z } from 'zod';

/**
 * The messages a worker and Wilson exchange over the worker connection: one WebSocket the worker opens
 * to `/api/workers/connect`, authenticated with its host's worker token.
 *
 * Each frame is one JSON text message. Wilson drives: it sends `call`s, each one `ExecutionHost`
 * primitive (`apps/api/src/modules/host/execution.host.ts`), and `spawn`s, each one process whose
 * stdio streams both ways. The worker only answers. It never decides what to run, so a worker is as
 * trusting of Wilson as an SSH host is of the key that reaches it, and no more.
 *
 * Bump {@link WORKER_PROTOCOL_VERSION} for any change a worker built against the old one would
 * misread. Wilson refuses a worker whose `hello` names another version, rather than guessing.
 */
export const WORKER_PROTOCOL_VERSION = 1;

/** The path the worker connects to, on the API's own origin. */
export const WORKER_CONNECT_PATH = '/api/workers/connect';

/**
 * WebSocket close codes Wilson ends a connection with, in the 4000 to 4999 range the spec leaves to
 * applications. A worker reconnects after any close but these: each means trying again unchanged
 * would fail the same way.
 */
export const WorkerCloseCode = {
    /** The `hello` was missing, malformed, or named another protocol version. */
    BadHello: 4400,
    /** Another connection for the same host took this one's place. */
    Superseded: 4409,
} as const;

/** A failure, shaped as `execFile`'s errors are, so Wilson can rebuild one its callers already handle. */
export const WorkerError = z.object({
    message: z.string(),
    /** An exit code, or a string such as `ENOENT` when there was no process or no file. */
    code: z.union([z.number(), z.string()]).optional(),
    killed: z.boolean().optional(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
});
export type WorkerError = z.infer<typeof WorkerError>;

/** `ExecOptions` as it travels: the same fields, all of them describing the worker's machine. */
export const ExecOptionsMessage = z.object({
    cwd: z.string(),
    timeoutMs: z.number().int().positive().optional(),
    maxBuffer: z.number().int().positive().optional(),
    /** The whole environment, before `hostEnv` and the passthrough names are taken from the worker's own. */
    env: z.record(z.string(), z.string()).optional(),
    hostEnv: z.array(z.string()).optional(),
});
export type ExecOptionsMessage = z.infer<typeof ExecOptionsMessage>;

/** One primitive Wilson asks the worker to run. Every path is absolute, on the worker's machine. */
export const CallOp = z.discriminatedUnion('op', [
    /** Answers `pong`. How a probe tells a live connection from one that has only not closed yet. */
    z.object({ op: z.literal('ping') }),
    z.object({ op: z.literal('readFile'), path: z.string() }),
    z.object({ op: z.literal('writeFile'), path: z.string(), content: z.string() }),
    z.object({ op: z.literal('mkdir'), path: z.string() }),
    z.object({ op: z.literal('stat'), path: z.string() }),
    z.object({ op: z.literal('realpath'), path: z.string() }),
    z.object({ op: z.literal('copyFile'), from: z.string(), to: z.string() }),
    z.object({ op: z.literal('unlink'), path: z.string() }),
    z.object({ op: z.literal('removeTree'), path: z.string() }),
    z.object({ op: z.literal('exec'), file: z.string(), args: z.array(z.string()), options: ExecOptionsMessage }),
    /** A file's bytes, base64: how a git bundle carrying a card's commits comes back from the worker. */
    z.object({ op: z.literal('readBytes'), path: z.string() }),
    /** Write `data` (base64) to `path`: how a git bundle carrying a card's base reaches the worker. */
    z.object({ op: z.literal('writeBytes'), path: z.string(), data: z.string() }),
]);
export type CallOp = z.infer<typeof CallOp>;

/** What each op resolves with, when it succeeds. */
export interface CallResults {
    ping: 'pong';
    readFile: string;
    writeFile: undefined;
    mkdir: undefined;
    stat: { isDirectory: boolean; mtimeMs: number };
    realpath: string;
    copyFile: undefined;
    unlink: undefined;
    removeTree: undefined;
    exec: { stdout: string; stderr: string };
    readBytes: string;
    writeBytes: undefined;
}

/** Where a project lives on the worker's machine, as its host's `wilson.host_projects` row says. */
export const WorkerProject = z.object({
    project: z.string(),
    codeRoot: z.string(),
    worktreeRoot: z.string(),
    runRoot: z.string(),
});
export type WorkerProject = z.infer<typeof WorkerProject>;

/** Wilson to worker. */
export const ToWorker = z.discriminatedUnion('type', [
    /**
     * The answer to `hello`: which host this connection is, and the projects it serves. A worker
     * refuses any file path outside those projects' roots, as a check of its own on top of Wilson's.
     * Sent again whenever Wilson connects to the host for a probe or a stage, so a project served
     * since the worker connected is known to it before any work for it arrives.
     */
    z.object({ type: z.literal('welcome'), host: z.string(), projects: z.array(WorkerProject) }),
    z.object({ type: z.literal('call'), id: z.string(), call: CallOp }),
    /**
     * Start a process with piped stdio: the engine, for the Agent SDK's `spawnClaudeCodeProcess`.
     * `env` is only the SDK's own `CLAUDE_CODE_*` and `CLAUDE_AGENT_SDK_*` variables; the worker adds
     * its own `PATH` and the rest, and its own engine token.
     */
    z.object({
        type: z.literal('spawn'),
        id: z.string(),
        command: z.string(),
        args: z.array(z.string()),
        cwd: z.string().optional(),
        env: z.record(z.string(), z.string()),
    }),
    /** Bytes for a spawned process's stdin, base64. */
    z.object({ type: z.literal('stdin'), id: z.string(), data: z.string() }),
    z.object({ type: z.literal('stdin-end'), id: z.string() }),
    z.object({ type: z.literal('kill'), id: z.string(), signal: z.string().optional() }),
    /**
     * The engine's sign-in check, as `ExecutionHost.runClaude`: `claude` with `args`, started as
     * `spawn` would start it, collected and answered as a `result` for `id`.
     */
    z.object({ type: z.literal('run-claude'), id: z.string(), args: z.array(z.string()), timeoutMs: z.number().int().positive() }),
]);
export type ToWorker = z.infer<typeof ToWorker>;

/**
 * Worker to Wilson. A plain union rather than one discriminated on `type`, since the two `result`
 * shapes share theirs; `type` and then `ok` still narrow it.
 */
export const FromWorker = z.union([
    /** The first message on every connection. Nothing else is accepted until Wilson has answered it. */
    z.object({
        type: z.literal('hello'),
        protocol: z.number().int(),
        /** The worker program's own version, for logs and the probe. */
        workerVersion: z.string(),
        /** `process.platform` on the worker's machine. */
        platform: z.string(),
    }),
    z.object({ type: z.literal('result'), id: z.string(), ok: z.literal(true), value: z.unknown().optional() }),
    z.object({ type: z.literal('result'), id: z.string(), ok: z.literal(false), error: WorkerError }),
    /** Output from a spawned process, base64, in the order it was written. */
    z.object({ type: z.literal('out'), id: z.string(), stream: z.enum(['stdout', 'stderr']), data: z.string() }),
    /** A spawned process ended, or never started (`error` set, `code` and `signal` null). */
    z.object({
        type: z.literal('exit'),
        id: z.string(),
        code: z.number().int().nullable(),
        signal: z.string().nullable(),
        error: WorkerError.optional(),
    }),
]);
export type FromWorker = z.infer<typeof FromWorker>;

/** Parse one frame, or undefined when it is not JSON or not a message of this direction. */
export const parseFrame = <T>(schema: z.ZodType<T>, raw: string): T | undefined => {
    let json: unknown;
    try {
        json = JSON.parse(raw);
    } catch {
        return undefined;
    }
    const parsed = schema.safeParse(json);
    return parsed.success ? parsed.data : undefined;
};
