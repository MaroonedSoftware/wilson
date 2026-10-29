import { CONTEXT_OVERFLOW_REASON, isContextOverflow, isPermanentFailure } from '#modules/stages/permanent.failure.js';
import { StageConfigError } from '#modules/stages/stage.config.js';
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
     * Leave a card exactly where it is — not just a dependency-blocked one.
     *
     * "Not now", not "never" (unlike `poison`): the outstanding cards may simply not have merged
     * yet, and poisoning here is precisely the false positive `permanent.failure.ts` warns against —
     * a card that would have recovered gets stranded. Nothing is written to the board: the card's
     * stage and retries are untouched, and the same dispatch that failed today succeeds unchanged
     * once something enqueues it again.
     *
     * Also carries a `StageConfigError` whose `stages.yaml` will not load: that failure is not about
     * this card at all, it is true for every card that would load the same file, so poisoning each as
     * it arrives would turn one config typo into a board full of poisoned cards a human then walks
     * back one at a time. `outstanding` is omitted (not written as an empty array) for that case — the
     * field means "these cards are in the way", and an unsatisfied dependency always has at least one;
     * its absence is what keeps `dispatch.deferred` distinguishing a broken config from a dependency
     * list that happens to be empty.
     */
    | { readonly kind: 'defer'; readonly reason: string; readonly outstanding?: string[] }
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
    /**
     * One attempt, then flag — not poisoned, not retried, same shape as `flag-rebase` (card 0072).
     *
     * A context-window overflow shares `isPermanentFailure`'s `invalid_request_error` class but is
     * not the same kind of never as the other things that flag poisons: it is a fact about how big
     * this stage's turn got, not about the deployment, and it is recoverable by doing the stage
     * differently — a fresh session on the same branch, or a smaller card. That choice is a human's
     * to make, not the runner's, so this flags and stops rather than guessing.
     */
    | { readonly kind: 'flag-context-overflow'; readonly reason: string }
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
 * **The order below is the contract, not an implementation detail.** `NotDispatchableError`,
 * `RebaseConflictError` and `StageConfigError` are all checked ahead of `isPermanentFailure` because
 * this codebase throws them and gives them a discriminant; `isPermanentFailure` stays message-based
 * because neither the SDK nor the provider offers anything better for a provider error, and that
 * pattern matching must never get first look at an error that already carries its own type.
 *
 * **An unrecognised `NotDispatchableReason` poisons.** That is an allowlist, deliberately: a new
 * reason kind added to `stage.dispatcher.ts` without a branch here turns the card it describes into
 * a terminal one, which is loud rather than silent. Adding a kind there means adding it here — the
 * `never` check in `CardStageJob.settle` makes the second half of that a compile error, but only
 * once a matching arm exists on `DispatchOutcome`.
 *
 * **`isContextOverflow` is checked ahead of `isPermanentFailure`, for the same reason the typed
 * errors above it are** (card 0072): `isPermanentFailure`'s `PERMANENT` list already matches a
 * context overflow's `invalid_request_error` class, and if that broader, message-based pattern got
 * first look it would poison a card that a fresh session or a smaller card can actually recover.
 */
export const classifyDispatchFailure = (error: unknown): DispatchOutcome => {
    if (error instanceof NotDispatchableError) {
        if (error.reason.kind === 'unsatisfied-dependency') {
            return { kind: 'defer', outstanding: error.reason.outstanding, reason: error.message };
        }
        if (error.reason.kind === 'needs-human') {
            return { kind: 'defer-flagged', reason: error.message };
        }
        // Every host busy, draining or down is "not now": a slot frees when another stage ends,
        // and the poller enqueues the card again on its next tick.
        if (error.reason.kind === 'no-host' || error.reason.kind === 'no-local-slot') {
            return { kind: 'defer', reason: error.message };
        }
        if (error.reason.kind === 'wrong-stage' && isTerminal(error.reason.actualStage)) {
            return { kind: 'stale', actualStage: error.reason.actualStage };
        }
        return { kind: 'poison', error };
    }

    if (error instanceof RebaseConflictError) {
        return { kind: 'flag-rebase', error };
    }

    if (error instanceof StageConfigError) {
        // `stage-not-found` is deterministic for this job — no action on this card changes it, so it
        // poisons exactly as wrong-stage does. `config-invalid` means `stages.yaml` itself is missing
        // or malformed, which is true for every card that would load it, not this one — that defers,
        // same "not now, not never" shape as an unsatisfied dependency.
        if (error.kind === 'stage-not-found') {
            return { kind: 'poison', error };
        }
        return { kind: 'defer', reason: error.message };
    }

    if (isContextOverflow(error)) {
        return { kind: 'flag-context-overflow', reason: CONTEXT_OVERFLOW_REASON };
    }

    if (!isPermanentFailure(error)) {
        return { kind: 'retry' };
    }

    return { kind: 'poison', error };
};
