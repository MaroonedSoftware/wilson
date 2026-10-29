import { Injectable } from 'injectkit';
import { httpError } from '@maroonedsoftware/errors';
import { DateTime } from 'luxon';
import { CLAUDE_BINARY_VERSION } from '#modules/agent/cli.engine.version.js';
import type { Host } from '../../generated/hosts.js';
import type { ExecFailure, ExecutionHost } from './execution.host.js';
import { HostConnector } from './host.connector.js';
import { HostRepository, type HostProbeRow, type HostRow } from './host.repository.js';
import { toHost } from './hosts.service.js';
import { WorkerConnections } from '#modules/worker/worker.connections.js';

/** How long one probe command may take before the host is reported unreachable. */
const PROBE_COMMAND_TIMEOUT_MS = 30_000;

/**
 * The host's boot time in seconds since the epoch: Linux's `/proc/stat`, else BSD's
 * `kern.boottime`, so a macOS host answers too. That one prints `{ sec = N, usec = M } ...`, so the
 * pattern is anchored at the start: unanchored, `.*sec` matches `usec` instead.
 */
const BOOT_TIME_SCRIPT = `awk '/^btime/ { print $2 }' /proc/stat 2>/dev/null || sysctl -n kern.boottime | sed -E 's/^\\{ sec = ([0-9]+).*/\\1/'`;

/**
 * Connects to a host and records what is there (`POST /api/hosts/{name}/probe`).
 *
 * Every check runs even after one fails, so one probe reports everything wrong with a host rather
 * than the first thing. A failed check is a result, recorded with `ok: false`, never an error
 * response: the caller asked what state the host is in, and "unreachable" is an answer.
 *
 * What it checks, and why each matters to a stage placed there:
 * - SSH reaches it, without a prompt. A `worker` host cannot be reached yet, so it fails here.
 * - `claude` is on its `PATH`, since the engine runs there, and is signed in the way an engine
 *   started there would be. A version other than the one this
 *   machine's probes last passed against is reported, not refused: the host's engine has not been
 *   through `cli.engine.contract.probe.ts`, which is worth knowing before trusting it.
 * - Each project's `codeRoot` is a git repository, since worktrees are cut from it, and its worktree
 *   and run roots can be created.
 * - Each variable it says it supplies to configured commands (`commandEnv`) is set there.
 * - Given a lifetime, when it will stop: boot time plus the lifetime.
 */
@Injectable()
export class HostProber {
    // `workers` is optional so the tests that build a prober by hand for SSH hosts need not make one.
    constructor(
        private readonly hosts: HostRepository,
        private readonly connector: HostConnector,
        private readonly workers?: WorkerConnections,
    ) {}

    async probe(name: string): Promise<Host> {
        const row = await this.hosts.find(name);
        if (!row) throw httpError(404).withDetails({ reason: `host "${name}" is not registered` });
        if (!row.enabled) throw httpError(409).withDetails({ reason: `host "${name}" is disabled; enable it before probing it` });

        await this.hosts.recordProbe(name, await this.inspect(row));
        return toHost((await this.hosts.find(name))!);
    }

    /** Run every check against `row`'s host and say what was found. Writes nothing. */
    async inspect(row: HostRow): Promise<HostProbeRow> {
        const probedAt = DateTime.now();
        // A connected worker answers, but nothing can run a stage's primitives over its connection
        // yet, so even a live one fails the probe: that is what keeps placement from choosing it.
        if (row.kind === 'worker') {
            const connection = this.workers?.get(row.name);
            if (!connection) return { probedAt, ok: false, detail: 'no worker is connected for this host' };
            const pong = await connection.call({ op: 'ping' }, PROBE_COMMAND_TIMEOUT_MS).catch((err: Error) => err);
            if (pong instanceof Error) return { probedAt, ok: false, detail: `the worker connection did not answer: ${pong.message}` };
            const { workerVersion, platform } = connection.hello;
            return { probedAt, ok: false, detail: `worker ${workerVersion} on ${platform} is connected, but stages cannot run on a worker yet` };
        }
        const host = this.connector.connect(row);

        const reach = await run(host, 'true', []);
        if (reach instanceof Error) {
            return { probedAt, ok: false, detail: `cannot reach ${row.sshTarget}: ${reason(reach)}` };
        }

        const problems: string[] = [];
        const notes: string[] = [];

        let engineVersion: string | undefined;
        const version = await run(host, 'claude', ['--version']);
        if (version instanceof Error) {
            problems.push(`claude is not runnable there: ${reason(version)}`);
        } else {
            engineVersion = version.split(/\s+/)[0];
            if (engineVersion !== CLAUDE_BINARY_VERSION) {
                notes.push(`claude ${engineVersion} has not been through the engine probes (this machine's last passed on ${CLAUDE_BINARY_VERSION})`);
            }
        }

        // Signed in the way an engine started there would be: the same environment and token
        // `spawnClaude` gives it, not a login shell's. A version answering says nothing about this:
        // an agent VM's `claude` runs fine and is signed in only inside the desktop app's sessions.
        if (!(version instanceof Error) && host.runClaude) {
            const status = await host.runClaude(['auth', 'status'], PROBE_COMMAND_TIMEOUT_MS).then(
                result => result.stdout,
                (err: ExecFailure) => err,
            );
            const loggedIn = status instanceof Error ? undefined : parseLoggedIn(status);
            if (loggedIn === false) {
                problems.push(
                    'claude is not signed in for an engine started there; set REMOTE_CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) in apps/api/.env',
                );
            } else if (loggedIn === undefined) {
                notes.push(`could not tell whether claude is signed in there${status instanceof Error ? `: ${reason(status)}` : ''}`);
            }
        }

        for (const project of row.projects) {
            const repo = await run(host, 'git', ['-C', project.codeRoot, 'rev-parse', '--git-dir']);
            if (repo instanceof Error) problems.push(`${project.project}: ${project.codeRoot} is not a git repository: ${reason(repo)}`);
            const roots = await run(host, 'mkdir', ['-p', '--', project.worktreeRoot, project.runRoot]);
            if (roots instanceof Error) problems.push(`${project.project}: cannot create its worktree and run roots: ${reason(roots)}`);
        }
        if (row.projects.length === 0) notes.push('serves no project yet');

        // The way a configured command will see each one: taken from the host's own environment.
        // A VM nobody has signed in to GitHub yet has no GITHUB_TOKEN, and its setup would fail later
        // for a reason that is clearer said now.
        for (const name of row.commandEnv) {
            const set = await run(host, 'sh', ['-c', `test -n "\${${name}-}"`], [name]);
            if (set instanceof Error) problems.push(`${name} is not set in its environment, so commands there would run without it`);
        }

        let expiresAt: DateTime | undefined;
        if (row.lifetimeMinutes !== undefined) {
            const boot = await run(host, 'sh', ['-c', BOOT_TIME_SCRIPT]);
            const seconds = boot instanceof Error ? NaN : Number(boot.trim());
            if (Number.isFinite(seconds) && seconds > 0) {
                expiresAt = DateTime.fromSeconds(seconds).plus({ minutes: row.lifetimeMinutes });
            } else {
                problems.push(`could not read its boot time, so its expiry is unknown${boot instanceof Error ? `: ${reason(boot)}` : ''}`);
            }
        }

        const ok = problems.length === 0;
        const detail = [...problems, ...notes].join('; ');
        return {
            probedAt,
            ok,
            ...(detail && { detail }),
            ...(engineVersion && { engineVersion }),
            ...(expiresAt && { expiresAt }),
        };
    }
}

/** `loggedIn` from `claude auth status`'s JSON, or undefined when the output is not that shape. */
const parseLoggedIn = (stdout: string): boolean | undefined => {
    try {
        const parsed = JSON.parse(stdout) as { loggedIn?: unknown };
        return typeof parsed.loggedIn === 'boolean' ? parsed.loggedIn : undefined;
    } catch {
        return undefined;
    }
};

/** Run one check from `/`, with only the host's own `PATH` and `HOME`. Resolves to stdout or the failure. */
const run = async (host: ExecutionHost, file: string, args: string[], hostEnv: readonly string[] = []): Promise<string | ExecFailure> =>
    host
        .exec(file, args, { cwd: '/', env: {}, hostEnv, timeoutMs: PROBE_COMMAND_TIMEOUT_MS })
        .then(result => result.stdout)
        .catch((err: ExecFailure) => err);

/** The most useful line of a failure: its stderr when it wrote any, otherwise its message. */
const reason = (failure: ExecFailure): string => (failure.stderr?.trim().split('\n').pop() || failure.message).slice(0, 300);
