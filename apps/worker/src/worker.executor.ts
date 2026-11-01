import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import {
    commandEnvironment,
    engineEnvironment,
    inheritedEnvironment,
    type CallOp,
    type FromWorker,
    type ToWorker,
    type WorkerError,
} from '@wilson/worker-protocol';

const execFileAsync = promisify(execFile);

/**
 * Answers git's request for credentials from the environment. The token lives in this one process
 * tree: not in argv, where `ps` would show it, and not in the remote URL, which `clone` would keep in
 * `.git/config` for every later stage to read. The same helper as `GitHubCloner`'s, in apps/api.
 */
const CREDENTIAL_HELPER = '!f() { test "$1" = get && printf "username=x-access-token\\npassword=%s\\n" "$WILSON_GIT_TOKEN"; }; f';

/** How long one clone may take. A large repository's first clone is the slowest thing a worker does. */
const CLONE_TIMEOUT_MS = 30 * 60_000;

type Env = Readonly<Record<string, string | undefined>>;

/** The `execFile`-shaped fields of whatever an operation threw, for Wilson to rebuild the same error. */
export const toWorkerError = (err: unknown): WorkerError => {
    const e = err as Partial<Error> & { code?: unknown; killed?: unknown; stdout?: unknown; stderr?: unknown };
    return {
        message: e.message ?? String(err),
        ...((typeof e.code === 'number' || typeof e.code === 'string') && { code: e.code }),
        ...(typeof e.killed === 'boolean' && { killed: e.killed }),
        ...(typeof e.stdout === 'string' && { stdout: e.stdout }),
        ...(typeof e.stderr === 'string' && { stderr: e.stderr }),
    };
};

export interface WorkerExecutorOptions {
    /** The worker's own environment, which the passthrough names, `hostEnv` and any fallback engine token come from. */
    env?: Env;
    /** The engine binary. A test substitutes a stand-in. */
    claudeCommand?: string;
    /**
     * Refuses a file path before anything touches it, with the reason; undefined lets it through. The
     * worker program passes one that keeps every path inside its host's project roots.
     */
    checkPath?: (path: string) => string | undefined;
    /** The same for a command's or the engine's working folder. Defaults to `checkPath`. */
    checkCwd?: (cwd: string) => string | undefined;
}

/** Throw the `EACCES` a refused path gets, when there is a refusal. */
const refuseWith = (refusal: string | undefined, path: string): void => {
    if (refusal) throw Object.assign(new Error(`EACCES: ${refusal}, '${path}'`), { code: 'EACCES' });
};

/**
 * Carries out what Wilson sends over a worker connection on this machine, and reports back through
 * `send`: each `call` with the `node:fs` or `execFile` call `LocalHost` would make, so a primitive on a
 * worker behaves as it would on Wilson's own machine, and each `spawn` as a child process whose stdio
 * streams back as `out` messages.
 *
 * It holds the processes it started, so a lost connection can end them all ({@link killAll}): a test
 * suite left running on a worker after the stage that started it is gone would only hold the machine.
 */
export class WorkerExecutor {
    private readonly processes = new Map<string, ChildProcessWithoutNullStreams>();
    private readonly env: Env;
    private readonly claudeCommand: string;

    constructor(
        private readonly send: (message: FromWorker) => void,
        private readonly options: WorkerExecutorOptions = {},
    ) {
        this.env = options.env ?? process.env;
        this.claudeCommand = options.claudeCommand ?? 'claude';
    }

    /** Act on one message from Wilson. Never throws: every failure is reported back as one. */
    handle(message: ToWorker): void {
        switch (message.type) {
            case 'call':
                void this.answer(message.id, () => this.call(message.call));
                return;
            case 'run-claude':
                void this.answer(message.id, () => this.runClaude(message.args, message.timeoutMs, message.engineToken));
                return;
            case 'spawn':
                this.spawn(message);
                return;
            case 'stdin':
                this.processes.get(message.id)?.stdin.write(Buffer.from(message.data, 'base64'));
                return;
            case 'stdin-end':
                this.processes.get(message.id)?.stdin.end();
                return;
            case 'kill':
                this.processes.get(message.id)?.kill((message.signal as NodeJS.Signals | undefined) ?? 'SIGTERM');
                return;
            case 'welcome':
                return;
        }
    }

    /** End every process this executor started: the connection that asked for them is gone. */
    killAll(): void {
        for (const child of this.processes.values()) child.kill('SIGTERM');
    }

    private async answer(id: string, run: () => Promise<unknown>): Promise<void> {
        try {
            const value = await run();
            this.send({ type: 'result', id, ok: true, ...(value !== undefined && { value }) });
        } catch (err) {
            this.send({ type: 'result', id, ok: false, error: toWorkerError(err) });
        }
    }

    private guard(...paths: string[]): void {
        for (const path of paths) refuseWith(this.options.checkPath?.(path), path);
    }

    private guardCwd(cwd: string): void {
        refuseWith((this.options.checkCwd ?? this.options.checkPath)?.(cwd), cwd);
    }

    private async call(call: CallOp): Promise<unknown> {
        switch (call.op) {
            case 'ping':
                return 'pong';
            case 'readFile':
                this.guard(call.path);
                return readFile(call.path, 'utf8');
            case 'writeFile':
                this.guard(call.path);
                return writeFile(call.path, call.content, 'utf8');
            case 'mkdir':
                this.guard(call.path);
                await mkdir(call.path, { recursive: true });
                return undefined;
            case 'stat': {
                this.guard(call.path);
                const found = await stat(call.path);
                return { isDirectory: found.isDirectory(), mtimeMs: found.mtimeMs };
            }
            case 'realpath':
                this.guard(call.path);
                return realpath(call.path);
            case 'copyFile':
                this.guard(call.from, call.to);
                return copyFile(call.from, call.to);
            case 'unlink':
                this.guard(call.path);
                return unlink(call.path);
            case 'removeTree':
                this.guard(call.path);
                return rm(call.path, { recursive: true, force: true });
            case 'readBytes':
                this.guard(call.path);
                return (await readFile(call.path)).toString('base64');
            case 'writeBytes':
                this.guard(call.path);
                return writeFile(call.path, Buffer.from(call.data, 'base64'));
            case 'exec': {
                this.guardCwd(call.options.cwd);
                const { options } = call;
                // Only the options Wilson set, for the reason `LocalHost.exec` gives: an explicit
                // `maxBuffer: undefined` would replace execFile's 1 MiB cap with none.
                const { stdout, stderr } = await execFileAsync(call.file, call.args, {
                    cwd: options.cwd,
                    ...(options.timeoutMs !== undefined && { timeout: options.timeoutMs }),
                    ...(options.maxBuffer !== undefined && { maxBuffer: options.maxBuffer }),
                    env:
                        options.env !== undefined ? commandEnvironment(options.env, options.hostEnv ?? [], this.env) : inheritedEnvironment(this.env),
                });
                return { stdout, stderr };
            }
            case 'clone':
                this.guard(call.path);
                return this.clone(call.url, call.path, call.token);
        }
    }

    /**
     * Clone beside `path` and rename into place, so a failure leaves nothing a later attempt would
     * mistake for a finished clone. Two stages can land here at once; the one that loses the rename
     * finds the other's clone there, which is what it wanted.
     */
    private async clone(url: string, path: string, token: string): Promise<void> {
        const partial = `${path}.${randomUUID()}.cloning`;
        await mkdir(dirname(path), { recursive: true });
        try {
            await execFileAsync(
                'git',
                ['-c', 'credential.helper=', '-c', `credential.helper=${CREDENTIAL_HELPER}`, 'clone', '--quiet', url, partial],
                {
                    timeout: CLONE_TIMEOUT_MS,
                    env: { ...inheritedEnvironment(this.env), WILSON_GIT_TOKEN: token, GIT_TERMINAL_PROMPT: '0' },
                },
            );
            await rename(partial, path);
        } catch (err) {
            const cloned = await execFileAsync('git', ['-C', path, 'rev-parse', '--git-dir']).then(
                () => true,
                () => false,
            );
            if (!cloned) throw err;
        } finally {
            await rm(partial, { recursive: true, force: true });
        }
    }

    private async runClaude(args: string[], timeoutMs: number, engineToken?: string): Promise<{ stdout: string; stderr: string }> {
        const { stdout, stderr } = await execFileAsync(this.claudeCommand, args, {
            cwd: '/',
            timeout: timeoutMs,
            env: engineEnvironment({}, this.env, engineToken),
        });
        return { stdout, stderr };
    }

    private spawn(message: Extract<ToWorker, { type: 'spawn' }>): void {
        const exit = (code: number | null, signal: string | null, error?: WorkerError) => {
            this.processes.delete(message.id);
            this.send({ type: 'exit', id: message.id, code, signal, ...(error && { error }) });
        };
        try {
            if (message.cwd) this.guardCwd(message.cwd);
        } catch (err) {
            exit(null, null, toWorkerError(err));
            return;
        }

        // `claude` is resolved on this machine, whatever Wilson named: the engine is the only thing a
        // spawn starts, and the name Wilson uses for it means nothing here.
        const child = spawn(this.claudeCommand, message.args, {
            ...(message.cwd && { cwd: message.cwd }),
            env: engineEnvironment(message.env, this.env, message.engineToken),
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        this.processes.set(message.id, child);
        const forward = (stream: 'stdout' | 'stderr') => (chunk: Buffer) =>
            this.send({ type: 'out', id: message.id, stream, data: chunk.toString('base64') });
        child.stdout.on('data', forward('stdout'));
        child.stderr.on('data', forward('stderr'));
        child.stdin.on('error', () => {
            // A process that exits before reading all its stdin is reported through its exit.
        });
        let started = true;
        child.on('error', err => {
            started = false;
            exit(null, null, toWorkerError(err));
        });
        child.on('close', (code, signal) => {
            if (started) exit(code, signal);
        });
    }
}
