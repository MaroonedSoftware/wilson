import type { ChildProcess } from 'node:child_process';

/**
 * Where a stage's file and command work actually happens.
 *
 * Every primitive here mirrors the `node:fs/promises` or `node:child_process` call it replaces, one
 * for one, including how it fails: a read of a missing file rejects with the same `Error` a
 * `readFile` would, and a command that exits non-zero rejects with an `ExecFailure` carrying the
 * same `code`, `killed`, `stdout` and `stderr` a promisified `execFile` does. Callers keep the error
 * handling they already had, and a host is a drop-in for the calls it replaces rather than a new
 * vocabulary to learn.
 *
 * Paths are absolute paths *on the host*, which is not necessarily this process's machine. Callers
 * build them with `node:path` from `ToolContext.worktreeRoot`, so a host that is not this machine
 * must still use POSIX paths, which every host Wilson can reach does.
 *
 * Today the only implementation is `LocalHost` (`local.execution.host.ts`): the daemon's own
 * filesystem and processes, exactly as before this seam existed. The seam is here so a stage can
 * later run its tools against a worktree on another machine without each tool learning how.
 */
export interface ExecutionHost {
    /** How this host is named in logs and events, e.g. `local`. */
    readonly name: string;

    /**
     * Variables this host's own environment supplies to the commands stage config runs on it
     * (`runConfiguredCommand`), and to nothing else. Unset or empty: none.
     */
    readonly commandEnv?: readonly string[];

    /** `readFile(path, 'utf8')`. */
    readFile(path: string): Promise<string>;

    /** `writeFile(path, content, 'utf8')`. Does not create parent directories; see `mkdir`. */
    writeFile(path: string, content: string): Promise<void>;

    /** `mkdir(path, { recursive: true })`. */
    mkdir(path: string): Promise<void>;

    /** `stat(path)`, narrowed to what a caller here asks of it. Rejects when the path is absent. */
    stat(path: string): Promise<HostStat>;

    /** `realpath(path)`. Rejects when the path is absent. */
    realpath(path: string): Promise<string>;

    /** `copyFile(from, to)`, both paths on this host. */
    copyFile(from: string, to: string): Promise<void>;

    /** `unlink(path)`. */
    unlink(path: string): Promise<void>;

    /** `rm(path, { recursive: true, force: true })`: absent is not an error. */
    removeTree(path: string): Promise<void>;

    /**
     * Run `file` with `args` and no shell, as a promisified `execFile` would. Resolves on exit code
     * zero; otherwise rejects with an `ExecFailure`.
     */
    exec(file: string, args: readonly string[], options: ExecOptions): Promise<ExecResult>;

    /**
     * Start the `claude` engine on this host, for the Agent SDK's `spawnClaudeCodeProcess`. Absent on
     * a host where the SDK's own local spawn already does the right thing, which is this machine.
     */
    spawnClaude?(options: ClaudeSpawnOptions): ChildProcess;
}

/** The part of the Agent SDK's `SpawnOptions` a host needs to start the engine. */
export interface ClaudeSpawnOptions {
    command: string;
    args: string[];
    cwd?: string;
    env: { [key: string]: string | undefined };
}

export interface HostStat {
    isDirectory: boolean;
    /** Last modification time, in milliseconds since the epoch, by the host's own clock. */
    mtimeMs: number;
}

export interface ExecOptions {
    /** Absolute working directory on the host. */
    cwd: string;
    /** Kill the process after this long; the rejection then has `killed: true`. */
    timeoutMs?: number;
    /** Most bytes of stdout or stderr to buffer before the process is killed. */
    maxBuffer?: number;
    /** The process's whole environment. Unset inherits the host's own. */
    env?: NodeJS.ProcessEnv;
    /**
     * Names to add to `env` from the host's own environment, with the host's values: what a host's
     * `commandEnv` says it supplies. Ignored when `env` is unset, since everything is inherited then.
     */
    hostEnv?: readonly string[];
}

export interface ExecResult {
    stdout: string;
    stderr: string;
}

/** What `exec` rejects with: the shape `execFile`'s own error has. */
export type ExecFailure = Error & {
    /** The exit code, or a string such as `ENOENT` when the process never started. */
    code?: number | string;
    /** True when the process was killed, which is how a timeout surfaces. */
    killed?: boolean;
    stdout?: string;
    stderr?: string;
};
