import { spawn, type ChildProcess } from 'node:child_process';
import { PASSED_THROUGH } from '#modules/stages/run.command.js';
import type { ClaudeSpawnOptions, ExecFailure, ExecOptions, ExecResult, ExecutionHost, HostStat } from './execution.host.js';

/** `execFile`'s own default, kept so a caller that sets no cap gets the cap it would have locally. */
const DEFAULT_MAX_BUFFER = 1024 * 1024;

/** How long a file primitive may take before it is treated as a lost connection. */
const FILE_OP_TIMEOUT_MS = 60_000;

/**
 * Seconds a remote command gets after `timeout` sends SIGTERM before it sends SIGKILL, so a test
 * runner can tear its children down before it is killed outright.
 */
const KILL_GRACE_SECONDS = 10;

/**
 * Options every connection uses.
 *
 * `BatchMode` so a missing key or an unknown host fails at once instead of waiting on a prompt nobody
 * will answer. `ControlMaster` multiplexes every command onto one connection per target, which is the
 * difference between a tool call costing a round trip and costing a fresh IAP tunnel and handshake.
 * The control socket lives in /tmp, not the per-user temp folder: on macOS that folder's path is long
 * enough that a socket inside it passes the 104-byte limit Unix sockets have.
 */
const SSH_OPTIONS = [
    '-o',
    'BatchMode=yes',
    '-o',
    'ControlMaster=auto',
    '-o',
    'ControlPath=/tmp/wilson-ssh-%C',
    '-o',
    'ControlPersist=600',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=4',
    '-T',
];

/**
 * `GIT_SSH_COMMAND` for git's own push and fetch to a host: the same connection options, so git rides
 * the multiplexed connection the host's other commands already opened. Only the options that apply
 * to a transport; git adds the target and the remote command itself.
 */
export const gitSshCommand = (sshCommand = 'ssh'): string => [sshCommand, ...SSH_OPTIONS.filter(option => option !== '-T')].map(shellQuote).join(' ');

/**
 * The environment prefixes the Agent SDK sets for the engine, which are forwarded to a remote
 * `claude`. Everything else in the SDK's `env` is this machine's own environment, which describes
 * nothing on the host: its `PATH`, its `HOME`, and `CLAUDE_CONFIG_DIR` when the `claude-config-dir`
 * setting names a folder here. The host's `claude` signs in from its own home instead.
 */
const CLAUDE_ENV_PREFIXES = ['CLAUDE_CODE_', 'CLAUDE_AGENT_SDK_'];

/** Quote one word for a POSIX shell: everything inside single quotes is literal, bar the quote. */
export const shellQuote = (word: string): string => `'${word.replace(/'/g, `'\\''`)}'`;

/**
 * An `env -i` prefix that starts from nothing and sets `env`, except that the keys `scrubbedEnv`
 * passes through from this machine (`PATH`, `HOME` and the rest) take the host's own values instead:
 * this machine's `PATH` names folders that do not exist there. `hostEnv` names more variables to
 * take from the host's environment the same way; each is expanded on the host, so its value never
 * travels from this machine.
 */
const envPrefix = (env: NodeJS.ProcessEnv, hostEnv: readonly string[] = []): string => {
    const words = ['env', '-i'];
    const fromHost = [...PASSED_THROUGH, ...hostEnv.filter(name => !PASSED_THROUGH.includes(name))];
    for (const key of fromHost) words.push(`${key}="\${${key}-}"`);
    for (const [key, value] of Object.entries(env)) {
        if (value === undefined || fromHost.includes(key)) continue;
        words.push(shellQuote(`${key}=${value}`));
    }
    return words.join(' ');
};

/** A failure shaped the way `execFile`'s are, so every caller's existing handling still applies. */
const failure = (message: string, fields: Omit<ExecFailure, keyof Error>): ExecFailure => Object.assign(new Error(message), fields);

/**
 * A machine reached with `ssh <target>`: every primitive is a short shell command run there.
 *
 * Nothing here is specific to an agent VM. `target` is whatever `ssh` accepts, so an SSH config entry
 * (`Host agent-*` with an IAP `ProxyCommand`, as TGA's `infra/agents` sets up) does the routing, and
 * this class needs no credentials of its own: it can reach exactly what the daemon user's `ssh` can.
 *
 * File primitives report a missing path with a message beginning `ENOENT`, the way `node:fs` would,
 * since callers show that message to the agent and some match on it.
 */
export class SshHost implements ExecutionHost {
    readonly name: string;

    /**
     * @param target What `ssh` connects to: an SSH config alias or `user@host`.
     * @param sshCommand The `ssh` binary. A test substitutes a script that runs the remote command
     *   locally, which exercises every quoting and shell path here without a second machine.
     */
    /**
     * @param commandEnv Variables the host's own environment supplies to configured commands, e.g.
     *   GITHUB_TOKEN on an agent VM, whose `.bashrc` sets it for every shell `ssh` starts there.
     */
    constructor(
        readonly target: string,
        private readonly sshCommand = 'ssh',
        readonly commandEnv: readonly string[] = [],
    ) {
        this.name = `ssh:${target}`;
    }

    async readFile(path: string): Promise<string> {
        return (await this.file(`cat -- ${shellQuote(path)}`, path, 'open')).stdout;
    }

    async writeFile(path: string, content: string): Promise<void> {
        await this.file(`cat > ${shellQuote(path)}`, path, 'open', content);
    }

    async mkdir(path: string): Promise<void> {
        await this.file(`mkdir -p -- ${shellQuote(path)}`, path, 'mkdir');
    }

    async stat(path: string): Promise<HostStat> {
        const p = shellQuote(path);
        // GNU `stat -c` first, BSD `stat -f` second, so a macOS host answers too.
        const { stdout } = await this.file(
            `if [ -d ${p} ]; then t=d; elif [ -e ${p} ]; then t=f; else echo 'No such file or directory' >&2; exit 2; fi; ` +
                `m=$(stat -c %.3Y -- ${p} 2>/dev/null || stat -f %Fm -- ${p}); echo "$t $m"`,
            path,
            'stat',
        );
        const [type, mtime] = stdout.trim().split(/\s+/);
        return { isDirectory: type === 'd', mtimeMs: Math.round(Number(mtime) * 1000) };
    }

    async realpath(path: string): Promise<string> {
        const p = shellQuote(path);
        // Refuses a missing path, as `node:fs`'s does: GNU `realpath` would resolve one.
        const { stdout } = await this.file(`[ -e ${p} ] || { echo 'No such file or directory' >&2; exit 2; }; realpath -- ${p}`, path, 'realpath');
        return stdout.replace(/\n$/, '');
    }

    async copyFile(from: string, to: string): Promise<void> {
        await this.file(`cp -- ${shellQuote(from)} ${shellQuote(to)}`, from, 'copyfile');
    }

    async unlink(path: string): Promise<void> {
        const p = shellQuote(path);
        await this.file(`{ [ -e ${p} ] || [ -L ${p} ]; } || { echo 'No such file or directory' >&2; exit 2; }; rm -- ${p}`, path, 'unlink');
    }

    async removeTree(path: string): Promise<void> {
        await this.file(`rm -rf -- ${shellQuote(path)}`, path, 'rm');
    }

    async exec(file: string, args: readonly string[], options: ExecOptions): Promise<ExecResult> {
        const command = [file, ...args].map(shellQuote).join(' ');
        const env = options.env ? `${envPrefix(options.env, options.hostEnv)} ` : '';
        // `timeout` on the host as well as the kill here: killing the local `ssh` closes the channel,
        // but a remote process with no terminal is not sent a hangup, and a test suite left running
        // on the host would hold its slot after the stage has given up on it.
        const limit =
            options.timeoutMs !== undefined
                ? `if command -v timeout >/dev/null 2>&1; then set -- timeout -k ${KILL_GRACE_SECONDS} ${Math.ceil(options.timeoutMs / 1000)}; else set --; fi; `
                : 'set --; ';
        // `|| exit`, not `&&`: the `if` and `exec` after it are separate commands, so `&&` would
        // guard only the first of them and run the command in the wrong folder.
        return this.run(`cd -- ${shellQuote(options.cwd)} || exit 1; ${limit}exec "$@" ${env}${command}`, options);
    }

    /**
     * Start `claude` on the host for the Agent SDK's `spawnClaudeCodeProcess`, with its stdio carried
     * over SSH. The SDK's own tool callbacks (`canUseTool`, hooks, in-process MCP tools) travel over
     * that same stdio, so they still run in this process; only the engine moves.
     *
     * The returned `ChildProcess` is the local `ssh`. It satisfies the SDK's `SpawnedProcess`, and
     * when it ends the engine's stdin closes, which is how the engine knows to exit.
     */
    spawnClaude(options: ClaudeSpawnOptions): ChildProcess {
        const env: NodeJS.ProcessEnv = {};
        for (const [key, value] of Object.entries(options.env)) {
            if (value !== undefined && CLAUDE_ENV_PREFIXES.some(prefix => key.startsWith(prefix))) env[key] = value;
        }
        const command = [options.command, ...options.args].map(shellQuote).join(' ');
        const cd = options.cwd ? `cd -- ${shellQuote(options.cwd)} || exit 1; ` : '';
        return spawn(this.sshCommand, [...SSH_OPTIONS, this.target, '--', `${cd}exec ${envPrefix(env)} ${command}`], {
            stdio: ['pipe', 'pipe', 'pipe'],
        });
    }

    /** A file primitive: `exec`'s transport, with a missing path reported as `node:fs` would. */
    private async file(script: string, path: string, syscall: string, input?: string): Promise<ExecResult> {
        try {
            return await this.run(script, { timeoutMs: FILE_OP_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }, input);
        } catch (err) {
            const e = err as ExecFailure;
            if (/No such file or directory/.test(e.stderr ?? '')) {
                throw failure(`ENOENT: no such file or directory, ${syscall} '${path}'`, { code: 'ENOENT', stderr: e.stderr });
            }
            throw err;
        }
    }

    /** Run `script` on the host through the remote user's shell, as `execFile` would run a file. */
    private run(script: string, options: Omit<ExecOptions, 'cwd' | 'env'>, input?: string): Promise<ExecResult> {
        const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
        return new Promise((resolve, reject) => {
            const child = spawn(this.sshCommand, [...SSH_OPTIONS, this.target, '--', script], { stdio: ['pipe', 'pipe', 'pipe'] });
            let stdout = '';
            let stderr = '';
            let killed = false;
            let overflow = false;

            const timer =
                options.timeoutMs !== undefined
                    ? setTimeout(() => {
                          killed = true;
                          child.kill('SIGTERM');
                      }, options.timeoutMs)
                    : undefined;

            const collect = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
                if (stream === 'stdout') stdout += chunk.toString();
                else stderr += chunk.toString();
                if (!overflow && stdout.length + stderr.length > maxBuffer) {
                    overflow = true;
                    child.kill('SIGTERM');
                }
            };
            child.stdout.on('data', collect('stdout'));
            child.stderr.on('data', collect('stderr'));

            child.on('error', err => {
                if (timer) clearTimeout(timer);
                reject(failure(`could not run ${this.sshCommand}: ${err.message}`, { code: (err as NodeJS.ErrnoException).code, stdout, stderr }));
            });
            child.on('close', (code, signal) => {
                if (timer) clearTimeout(timer);
                if (overflow) {
                    reject(failure('stdout maxBuffer length exceeded', { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', stdout, stderr }));
                } else if (killed) {
                    reject(failure(`command timed out on ${this.target}`, { killed: true, stdout, stderr }));
                } else if (code === 0) {
                    resolve({ stdout, stderr });
                } else if (code === 255) {
                    // `ssh`'s own failure code: the command never ran, or the connection died under it.
                    reject(failure(`ssh ${this.target} failed: ${stderr.trim() || `exit ${code}`}`, { code, stdout, stderr }));
                } else {
                    reject(
                        failure(`command failed on ${this.target} (exit ${code ?? signal}): ${stderr.trim()}`, {
                            code: code ?? undefined,
                            stdout,
                            stderr,
                        }),
                    );
                }
            });

            child.stdin.on('error', () => {
                // The remote end closing stdin early is reported through `close` with its exit code.
            });
            child.stdin.end(input ?? '');
        });
    }
}
