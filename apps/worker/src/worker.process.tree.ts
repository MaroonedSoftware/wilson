import { spawn, type ChildProcess } from 'node:child_process';

/** How long a process tree has to end on the signal it was sent before it gets `SIGKILL`. */
export const KILL_GRACE_MS = 5_000;

/** `execFile`'s own default for how much of each stream a command may produce. */
const DEFAULT_MAX_BUFFER = 1024 * 1024;

/**
 * Whether a process can lead a group of its own, so that everything it starts can be signalled with
 * it. Not on Windows, where only the process itself is reached.
 */
const OWN_GROUPS = process.platform !== 'win32';

/** What `spawn` needs for {@link endProcessTree} to reach everything the process starts. */
export const PROCESS_TREE_OPTIONS = { detached: OWN_GROUPS } as const;

/**
 * Signal `child`'s whole group. Falls back to the process alone when the group cannot be signalled,
 * which is also what a group with nothing left in it reports (`ESRCH`, or `EPERM` on macOS when only
 * zombies remain); signalling a process that has gone does nothing.
 */
const signalTree = (child: ChildProcess, signal: NodeJS.Signals): void => {
    if (OWN_GROUPS && child.pid !== undefined) {
        try {
            process.kill(-child.pid, signal);
            return;
        } catch {
            // Reported by `child.kill` below, if it is still there to report anything.
        }
    }
    child.kill(signal);
};

/**
 * End a process started with {@link PROCESS_TREE_OPTIONS} and everything it started: `signal` now, and
 * `SIGKILL` after `graceMs` to whatever is left. The second signal goes out even when the process
 * itself has exited, since what it started can outlive it and keep writing to its worktree.
 *
 * @returns once the last signal has been sent. The timer is deliberately not `unref`ed: a worker that
 * is stopping waits for it, because nothing would come back for a group left running once it has gone.
 */
export const endProcessTree = (child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM', graceMs: number = KILL_GRACE_MS): Promise<void> => {
    signalTree(child, signal);
    if (signal === 'SIGKILL') return Promise.resolve();
    return new Promise(resolve => {
        setTimeout(() => {
            signalTree(child, 'SIGKILL');
            resolve();
        }, graceMs);
    });
};

export interface CommandOptions {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs?: number;
    maxBuffer?: number;
    /** How long the command's tree has to end once it is stopped. */
    graceMs?: number;
}

/** A command as it runs: what it will produce, and how to stop it early. */
export interface RunningCommand {
    result: Promise<{ stdout: string; stderr: string }>;
    /** End the command's whole tree. Resolves once the last signal has been sent. */
    cancel(): Promise<void>;
}

/**
 * `execFile`, in a process group of its own. `execFile` cannot start one, so stopping a test runner
 * through it would leave the runner's workers going. It fails the way `execFile` does, with `code`,
 * `killed`, `signal`, `stdout` and `stderr` on the error, since Wilson rebuilds its callers' failures
 * from those. A timeout or an overflowing stream ends the whole tree rather than only the command.
 */
export const startCommand = (file: string, args: readonly string[], options: CommandOptions): RunningCommand => {
    const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
    const child = spawn(file, args, { cwd: options.cwd, env: options.env, ...PROCESS_TREE_OPTIONS });
    let stopping: Promise<void> | undefined;

    /** Stop reading first, so something that kept the pipes open cannot hold the answer back. */
    const stop = (): Promise<void> => {
        stopping ??= (() => {
            child.stdout.destroy();
            child.stderr.destroy();
            return endProcessTree(child, 'SIGTERM', options.graceMs);
        })();
        return stopping;
    };

    const result = new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        let overflow: Error | undefined;
        let timer: NodeJS.Timeout | undefined;

        const fail = (error: Error, fields: { code?: number | string | null; signal?: NodeJS.Signals | null }): void => {
            reject(Object.assign(error, fields, { killed: child.killed || stopping !== undefined, cmd: [file, ...args].join(' '), stdout, stderr }));
        };
        const overflowed = (stream: 'stdout' | 'stderr'): void => {
            overflow ??= Object.assign(new Error(`${stream} maxBuffer length exceeded`), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
            void stop();
        };

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
            stdout = (stdout + chunk).slice(0, maxBuffer);
            if (stdout.length === maxBuffer) overflowed('stdout');
        });
        child.stderr.on('data', (chunk: string) => {
            stderr = (stderr + chunk).slice(0, maxBuffer);
            if (stderr.length === maxBuffer) overflowed('stderr');
        });

        if (options.timeoutMs !== undefined) timer = setTimeout(() => void stop(), options.timeoutMs);

        // Never started: `close` may not follow, and there is nothing to end.
        child.once('error', error => {
            if (timer) clearTimeout(timer);
            fail(error, {});
        });
        child.once('close', (code, signal) => {
            if (timer) clearTimeout(timer);
            if (overflow) return fail(overflow, { signal });
            if (code === 0 && signal === null) return resolve({ stdout, stderr });
            fail(new Error(`Command failed: ${[file, ...args].join(' ')}\n${stderr}`), { code, signal });
        });
    });

    return { result, cancel: stop };
};
