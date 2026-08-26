/**
 * A FIFO in-process mutex that reports how long a caller had to queue.
 *
 * Extracted from what was `PnpmStoreLock` in `#modules/stages/run.command.js` (card 0081), verbatim
 * apart from taking the resource's name as a constructor argument, so the messages it logs read the
 * same as before. It moved here once a second resource needed the identical treatment: the code
 * repo's own worktree bookkeeping (`#modules/worktree/code.root.lock.js`). Two copies of a lock are
 * two chances to get the release path subtly different, and this one already had the part worth
 * keeping — the wait telemetry.
 *
 * In-process rather than a lockfile on disk: `job.runner.config.ts`'s `CARD_STAGE_CONCURRENCY` caps
 * how many `card.stage` jobs run at once *on this daemon process* — pg-boss's local worker
 * concurrency, not separate processes — so everything either lock can ever serialize lives in the
 * same Node event loop, and a plain in-memory queue is exactly as strong a guarantee as the problem
 * needs. It also gets "survives a killed process" for free: the lock lives in a module's memory, so
 * a process killed while holding it takes it down with it. There is no lockfile left on disk for the
 * next process to find still held, and no stale-lock timeout to get wrong.
 *
 * Not reentrant, deliberately: a lock that quietly lets its holder re-acquire it cannot tell that
 * apart from a second caller, and the guarantee it is bought for is exactly that distinction. A
 * caller with a public method that both takes the lock and calls another method that takes it must
 * split the inner one into a private unlocked form — see `WorktreeManager.reclaimUnlocked`.
 */
export class Mutex {
    /**
     * @param name How the resource is named in the wait messages, e.g. `pnpm store lock`. Reads
     *   directly after "waiting for the" and "acquired the", so it is a noun phrase, not a sentence.
     */
    constructor(private readonly name: string) {}

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
     *
     * `onWaited`, when given, fires once with the same figure `log`'s second message names, only on a
     * contended acquire — so a caller that keeps a durable record of what happened (an event, not
     * just a log line) can put the wait there too. Optional and appended last so the callers that
     * only pass `log` (the bash tool, the testing baseline, every worktree call) do not have to
     * change.
     */
    async run<T>(label: string, log: (message: string) => void, fn: () => Promise<T>, onWaited?: (waitedMs: number) => void): Promise<T> {
        const contendedWith = this.holder;
        if (contendedWith) {
            log(`${label} waiting for the ${this.name}, held by ${contendedWith}`);
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
            const waitedMs = Date.now() - waitStart;
            log(`${label} acquired the ${this.name} after waiting ${waitedMs}ms`);
            onWaited?.(waitedMs);
        }

        try {
            return await fn();
        } finally {
            this.holder = undefined;
            release();
        }
    }
}
