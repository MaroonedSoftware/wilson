import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface CommandFailure {
    reason: string;
}

/**
 * Run a configured command in a worktree, without a shell.
 *
 * Shared by worktree setup and exit-condition verification. Both take their command from stage
 * config rather than from the agent, so the allowlist does not apply — but the no-shell rule still
 * does, because a config string is not a reason to hand anything a shell.
 */
export const runConfiguredCommand = async (cwd: string, command: string, timeoutMs = 10 * 60 * 1000): Promise<CommandFailure | undefined> => {
    const [file, ...args] = command.trim().split(/\s+/).filter(Boolean);
    if (!file) return { reason: 'configured command is empty' };

    try {
        await exec(file, args, { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
        return undefined;
    } catch (err) {
        const e = err as Error & { stdout?: string; stderr?: string; code?: number; killed?: boolean };
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
 * In-process rather than a lockfile on disk: `job.runner.config.ts`'s `CARD_STAGE_CONCURRENCY` caps
 * how many `card.stage` jobs run at once *on this daemon process* — pg-boss's local worker
 * concurrency, not separate processes — so every install this bug can ever race lives in the same
 * Node event loop, and a plain in-memory queue is exactly as strong a guarantee as the problem
 * needs. It also gets "survives a killed process" for free: the lock lives in this module's memory,
 * so a process killed mid-install takes the lock down with it. There is no lockfile left on disk for
 * the next process to find still held, and no stale-lock timeout to get wrong.
 *
 * Only the install needs to be exclusive, not the stage around it — this class knows nothing about
 * stages, cards, or worktrees. Callers decide what's worth serializing: the dispatcher wraps only
 * `setupCommand`'s execution, and the bash tool wraps only requests that start with `pnpm install`.
 */
class PnpmStoreLock {
    /** The gate the next caller queues behind. Resolves when the current holder releases it. */
    private queue: Promise<void> = Promise.resolve();
    /** Label of whoever currently holds the lock (running `fn`, not just queued), for the wait log. */
    private holder: string | undefined;

    /**
     * Run `fn` exclusively against every other call to `run`, queued FIFO.
     *
     * `log` fires twice on a contended acquire — once immediately, naming who is already holding the
     * lock, and again once this call gets it, with how long it waited — so an operator watching a
     * stage sit for a minute can read "waiting for the install lock" in real time rather than only
     * after the fact, and tell that apart from the agent being stuck on something else entirely. An
     * uncontended acquire (the common case, and the only case when just one stage is running) logs
     * nothing at all.
     */
    async run<T>(label: string, log: (message: string) => void, fn: () => Promise<T>): Promise<T> {
        const contendedWith = this.holder;
        if (contendedWith) {
            log(`${label} waiting for the pnpm store lock, held by ${contendedWith}`);
        }

        const waitStart = Date.now();
        const previous = this.queue;
        let release!: () => void;
        this.queue = new Promise<void>(resolve => {
            release = resolve;
        });

        await previous;
        this.holder = label;
        if (contendedWith) {
            log(`${label} acquired the pnpm store lock after waiting ${Date.now() - waitStart}ms`);
        }

        try {
            return await fn();
        } finally {
            this.holder = undefined;
            release();
        }
    }
}

/** The one store lock for this process. A module-level singleton so every caller shares it. */
export const pnpmStoreLock = new PnpmStoreLock();
