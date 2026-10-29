import type { ExecFailure, ExecutionHost } from '#modules/host/execution.host.js';
import { localHost } from '#modules/host/local.execution.host.js';
import { Mutex } from '#shared/mutex.js';

export interface CommandFailure {
    reason: string;
}

/**
 * The environment a stage command runs with — shared by `runConfiguredCommand` below and by the
 * agent's own bash tool (`agent/tools/bash.tool.ts`).
 *
 * Allowlisted, not denylisted: a new secret added to the deployment's env should not silently become
 * visible to every build script because nobody remembered to add it to a deny list.
 */
export const PASSED_THROUGH = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'SHELL', 'USER', 'NODE_ENV'];

/**
 * `port`, when given, is `StageDispatcher`'s `DevServerPortAllocator` result for this stage's
 * worktree (card 0027) — injected explicitly as `PORT`, never read from `process.env.PORT`: the
 * daemon's own `PORT`, if it has one, is its own, and passing it through here would be exactly the
 * collision this card exists to prevent. Absent whenever no port range is configured (the default),
 * so a deploy that never sets `DEV_SERVER_PORT_RANGE` gets an environment identical to before this
 * parameter existed.
 */
export const scrubbedEnv = (port?: number): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = {};
    for (const key of PASSED_THROUGH) {
        const value = process.env[key];
        if (value !== undefined) env[key] = value;
    }
    // Card-injected, so a dev server started by a stage does not collide with another card's.
    env.CI = 'true';
    if (port !== undefined) env.PORT = String(port);
    return env;
};

/**
 * Run a configured command in a worktree, without a shell.
 *
 * Shared by worktree setup and exit-condition verification. Both take their command from stage
 * config rather than from the agent, so the allowlist does not apply — but the no-shell rule still
 * does, because a config string is not a reason to hand anything a shell. The environment is
 * scrubbed the same way the bash tool scrubs it: `setupCommand`, `buildCommand` and `testCommand`
 * are exactly as much "a build script" as anything the agent runs, and this process's env holds the
 * same provider keys and credentials the agent path is careful to withhold.
 *
 * `port` is threaded straight through to `scrubbedEnv` (card 0027) — optional and defaulting to
 * `undefined`, so the exit-condition verifiers, which never have a port to give, are unaffected.
 * Only `StageDispatcher`'s `setupCommand` call passes one, and only when a range is configured.
 *
 * `host` is the machine `cwd` is on: a caller with a `Worktree` passes `worktreeHost(worktree)`, so
 * the command runs where the tree is. Defaults to this machine, which every caller meant before it
 * existed.
 */
export const runConfiguredCommand = async (
    cwd: string,
    command: string,
    timeoutMs = 10 * 60 * 1000,
    port?: number,
    host: ExecutionHost = localHost,
): Promise<CommandFailure | undefined> => {
    const [file, ...args] = command.trim().split(/\s+/).filter(Boolean);
    if (!file) return { reason: 'configured command is empty' };

    try {
        // `hostEnv`: what the host says its own environment supplies to configured commands (a
        // package token on an agent VM). Only here, never in the bash tool: those are the setup and
        // test commands' business, not the agent's.
        await host.exec(file, args, { cwd, timeoutMs, maxBuffer: 16 * 1024 * 1024, env: scrubbedEnv(port), hostEnv: host.commandEnv });
        return undefined;
    } catch (err) {
        const e = err as ExecFailure;
        if (e.killed) return { reason: `\`${command}\` timed out` };
        const output = [e.stdout?.trim(), e.stderr?.trim()].filter(Boolean).join('\n').slice(-4000);
        return { reason: `\`${command}\` failed (exit ${e.code ?? 'unknown'})\n${output}` };
    }
};

/**
 * Serializes writes to pnpm's shared content-addressable store, in-process.
 *
 * `doFetchToStore` is pnpm writing that shared store, and two installs racing it is enough to break
 * both (card 0081) — one from `setupCommand` (this file, above) and one from an agent's own `pnpm
 * install` through the bash tool's allowlist (`agent/tools/bash.tool.ts`), which is on the
 * `implementing` stage's `allowedCommands`. Both paths import this one lock so either can hold it.
 *
 * A module-level singleton so every caller shares it. The queueing itself is `Mutex`
 * (`#shared/mutex.js`), which is where this class's body went once the code repo needed the same
 * treatment for its worktree bookkeeping; what stays here is the part that is about pnpm rather
 * than about locking.
 *
 * Only the install needs to be exclusive, not the stage around it — `Mutex` knows nothing about
 * stages, cards, or worktrees. Callers decide what's worth serializing: the dispatcher wraps only
 * `setupCommand`'s execution, and the bash tool wraps only requests that start with `pnpm install`.
 */
export const pnpmStoreLock = new Mutex('pnpm store lock');
