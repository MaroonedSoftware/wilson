import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

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

interface ProcessEntry {
    pid: number;
    ppid: number;
    pgid: number;
}

/** One `/proc/<pid>/stat`. The command name is in parentheses and may hold anything, spaces included. */
const parseStat = (pid: number, stat: string): ProcessEntry | undefined => {
    const [, ppid, pgid] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return ppid === undefined || pgid === undefined ? undefined : { pid, ppid: Number(ppid), pgid: Number(pgid) };
};

/**
 * Every process on this machine, or as many as could be read. `/proc` where there is one, since a
 * worker's image need not have `ps`, and `ps` elsewhere. Empty when neither answers, which leaves only
 * the group to signal.
 */
const processTable = (): ProcessEntry[] => {
    try {
        if (existsSync('/proc/self/stat')) {
            return readdirSync('/proc').flatMap(name => {
                if (!/^\d+$/.test(name)) return [];
                try {
                    return parseStat(Number(name), readFileSync(`/proc/${name}/stat`, 'utf8')) ?? [];
                } catch {
                    return []; // Gone between listing it and reading it.
                }
            });
        }
        return execFileSync('ps', ['-axo', 'pid=,ppid=,pgid='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
            .trim()
            .split('\n')
            .map(line => {
                const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number);
                return { pid: pid!, ppid: ppid!, pgid: pgid! };
            });
    } catch {
        return [];
    }
};

/**
 * Signal `child`'s tree. A group alone does not reach all of it: the engine runs each command in a
 * session of its own, and those commands would otherwise outlive it, so its descendants are walked as
 * well. `tree` holds what has been found so far, because once a process exits its children are
 * reparented and can no longer be found from it.
 *
 * Only a group led by a member of the tree is signalled as a group, so this can never reach the
 * worker's own. A failed signal means the process or group has gone, which is what was wanted (`ESRCH`,
 * or `EPERM` on macOS when only zombies remain).
 */
const signalTree = (child: ChildProcess, signal: NodeJS.Signals, tree: Set<number>): void => {
    if (!OWN_GROUPS || child.pid === undefined) {
        child.kill(signal);
        return;
    }
    tree.add(child.pid);
    const table = processTable();
    for (let found = true; found;) {
        found = false;
        for (const { pid, ppid } of table) {
            if (tree.has(ppid) && !tree.has(pid)) {
                tree.add(pid);
                found = true;
            }
        }
    }
    const groups = new Set(table.filter(({ pid, pgid }) => tree.has(pid) && tree.has(pgid)).map(({ pgid }) => pgid));
    groups.add(child.pid);
    const send = (target: number): void => {
        try {
            process.kill(target, signal);
        } catch {
            // Gone already.
        }
    };
    for (const group of groups) send(-group);
    for (const pid of tree) send(pid);
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
    const tree = new Set<number>();
    signalTree(child, signal, tree);
    if (signal === 'SIGKILL') return Promise.resolve();
    return new Promise(resolve => {
        setTimeout(() => {
            signalTree(child, 'SIGKILL', tree);
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
