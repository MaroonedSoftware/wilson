import { isPermanentFailure } from '#modules/stages/permanent.failure.js';
import { NotDispatchableError, RebaseConflictError } from '#modules/stages/stage.dispatcher.js';
import { isTerminal } from '#modules/stages/terminal.js';

/**
 * What a failed `StageDispatcher.run` means for the card.
 *
 * Every arm but `retry` settles the job: the attempt completes normally, the queue does not retry
 * it, and the card's claim is released. `retry` is the only one that rethrows.
 *
 * The errors are carried rather than reduced to a reason string here. `flag-rebase` needs the typed
 * `RebaseConflictError` for its `branch`/`targetSha`/`detail` fields, and `poison` composes its
 * reason the same way `poisonCard`'s other caller does — turning either into a string at
 * classification time would make this type prettier and the two effects harder to keep identical.
 */
export type DispatchOutcome =
    /**
     * A provider hiccup, a dropped connection, anything `isPermanentFailure` does not recognise.
     * Rethrown so the queue retries under its own policy.
     */
    | { readonly kind: 'retry' }
    /**
     * Leave a dependency-blocked card exactly where it is.
     *
     * "Not now", not "never" (unlike `poison`): the outstanding cards may simply not have merged
     * yet, and poisoning here is precisely the false positive `permanent.failure.ts` warns against —
     * a card that would have recovered gets stranded. Nothing is written to the board: the card's
     * stage and retries are untouched, and the same dispatch that failed today succeeds unchanged
     * once something enqueues it again.
     */
    | { readonly kind: 'defer'; readonly outstanding: string[]; readonly reason: string }
    /**
     * Leave a card the dispatcher found already flagged for a human exactly where it is.
     *
     * `assertDispatchable`'s `needs-human` check (card 0109) exists for the race between a job being
     * enqueued and dispatched: something else already wrote the flag, its reason, and its
     * notification before this job ever reached `dispatcher.run`. There is nothing new to write or
     * notify, and `poison` would be wrong twice over — a flagged card is not broken, and a human
     * clearing the flag makes it dispatchable again with no other change, the same "not now, not
     * never" shape `defer` gives an unsatisfied dependency.
     */
    | { readonly kind: 'defer-flagged'; readonly reason: string }
    /**
     * A job arrived for a card that has already finished — not a bug, once the card's current stage
     * is terminal. A card reaches `merged` (or `dropped`/`poisoned`) while a job for its last stage
     * is still queued, `wilson card move` reclaims the worktree on the human's transition, and this
     * job then dispatches into a card that is done. Poisoning it would be card 0066/0082's bug:
     * undoing a human's completed merge because a stale job showed up after the fact.
     */
    | { readonly kind: 'stale'; readonly actualStage: string }
    /**
     * One attempt, then flag — not poisoned, not retried, and `kickback` never sees it, because the
     * stage never ran and failed nothing.
     */
    | { readonly kind: 'flag-rebase'; readonly error: RebaseConflictError }
    /** Retrying cannot fix this. Terminal, and deliberately not a kickback — see `poisonCard`. */
    | { readonly kind: 'poison'; readonly error: unknown };

/** Every outcome that settles the job rather than rethrowing. */
export type SettledDispatch = Exclude<DispatchOutcome, { kind: 'retry' }>;

/**
 * Decide what a failure out of `StageDispatcher.run` means, without acting on it.
 *
 * This was an `instanceof` ladder inside `CardStageJob.runStage`, which is where four of the last
 * ten cards to touch that file made their edit — each one adding a branch to the ladder and a
 * handler beneath it. Pulled out, it is the same shape as `chain.decision.ts` and `dispatchable.ts`:
 * a pure decision with its own tests, so `runStage` stops being the file a new failure mode has to
 * be threaded through.
 *
 * **The order below is the contract, not an implementation detail.** `NotDispatchableError` and
 * `RebaseConflictError` are both checked ahead of `isPermanentFailure` because this codebase throws
 * them and gives them a discriminant; `isPermanentFailure` stays message-based because neither the
 * SDK nor the provider offers anything better for a provider error, and that pattern matching must
 * never get first look at an error that already carries its own type.
 *
 * **An unrecognised `NotDispatchableReason` poisons.** That is an allowlist, deliberately: a new
 * reason kind added to `stage.dispatcher.ts` without a branch here turns the card it describes into
 * a terminal one, which is loud rather than silent. Adding a kind there means adding it here — the
 * `never` check in `CardStageJob.settle` makes the second half of that a compile error, but only
 * once a matching arm exists on `DispatchOutcome`.
 */
export const classifyDispatchFailure = (error: unknown): DispatchOutcome => {
    if (error instanceof NotDispatchableError) {
        if (error.reason.kind === 'unsatisfied-dependency') {
            return { kind: 'defer', outstanding: error.reason.outstanding, reason: error.message };
        }
        if (error.reason.kind === 'needs-human') {
            return { kind: 'defer-flagged', reason: error.message };
        }
        if (error.reason.kind === 'wrong-stage' && isTerminal(error.reason.actualStage)) {
            return { kind: 'stale', actualStage: error.reason.actualStage };
        }
        return { kind: 'poison', error };
    }

    if (error instanceof RebaseConflictError) {
        return { kind: 'flag-rebase', error };
    }

    if (!isPermanentFailure(error)) {
        return { kind: 'retry' };
    }

    return { kind: 'poison', error };
};
