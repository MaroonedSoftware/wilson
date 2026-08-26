import type { StageConfig } from '#modules/stages/stage.config.js';

/**
 * How many times a stage may report a dropped result (`StageOutcome.resultDropped`) before those
 * attempts start spending `retries[stage.name]` like any other failure.
 *
 * Not zero: a dropped result cost nothing real — the stage did the work, the transport lost the
 * receipt — and charging it the same as a genuine failure on the very first occurrence would make
 * an infrastructure hiccup as expensive as the agent actually failing, which is precisely the
 * miscounting this card exists to fix. Not unbounded either: a stage that drops its result on
 * every attempt is not a one-off transport blip, it is a persistent fault, and it still has to
 * reach `needsHuman` rather than retry forever for free. Small and fixed rather than derived from
 * `maxKickbacks`, so raising a stage's ordinary retry budget does not also silently widen its free
 * allowance for this one failure mode.
 */
const RESULT_DROPPED_ALLOWANCE = 2;

/**
 * The `retries` key a stage's dropped-result count is tracked under — distinct from `stage.name`
 * itself, so spending the free allowance never touches the counter `maxKickbacks` checks.
 */
const droppedRetryKey = (stage: StageConfig): string => `${stage.name}:resultDropped`;

export interface KickbackDecision {
    /** The stage the card moves to. Its own name once `needsHuman` is set, so the card stays put. */
    target: string;
    /** The card's retry counters, with this stage's incremented. */
    retries: Record<string, number>;
    /** Set once `attempts` reaches `maxKickbacks`: the card is flagged for a human instead of moved. */
    needsHuman?: { reason: string };
}

/**
 * Decide where a card goes when `stage` fails, and count the attempt.
 *
 * The counter is per stage: incrementing `stage.name`'s count never touches any other stage's.
 * Once that count reaches `maxKickbacks`, the stage has failed as many times as it is allowed to,
 * and the card stays exactly where it failed — `target` is the stage's own name — flagged for a
 * human instead of routed to a lane. Where a card failed is information a lane would throw away.
 *
 * `stage.onFail` is what decides the target when the failure was a judgment — a review with a
 * blocker, a verifier rejecting a bad diff — and that is deliberate: the target is a property of
 * the stage that failed, chosen for who can fix it — see the `onFail` field in `stage.config.ts`
 * for the reasoning (card 0060). `unjudged` overrides that: when the run's own outcome says the
 * failure was not a statement about the code (a step, wall-clock or token budget cutoff, an engine
 * that stopped responding, a run that never reported, a result that never parsed — see
 * `StageOutcome.unjudged` in `stage.result.ts`), the code has not been evaluated at all, so there is
 * nothing for `onFail`'s target to fix. The stage that failed is the only one that can retry the
 * thing that actually failed, so the target is itself — the same rule `testing.onFail: testing`
 * expresses in config for one stage (card 0060), generalised here to every stage's own outcome
 * instead of relying on each stage's config to special-case it.
 *
 * This function treats self-targeting the same way whether it comes from `onFail` or from
 * `unjudged`: `target === stage.name` is returned the same way regardless of why, and the
 * maxKickbacks/needsHuman bookkeeping below does not care why the stage failed, only that it did —
 * a self-loop retries and eventually flags a human exactly like a kickback to any other stage.
 *
 * `testing.onFail: testing` is left in place, not replaced: it self-loops on *every* testing
 * failure, including a well-formed verdict that testing wrote no tests, or that its report is stale
 * — a judgment about the work, not a process failure, and one `unjudged` deliberately does not
 * cover (card 0062 chose that self-loop because testing has no downstream stage that could act on
 * the failure differently; see the `onFail` field in `stage.config.ts`). `unjudged` only removes the
 * gap card 0062 documented and left open in this file: it could tell "testing skipped its own job"
 * apart from "testing failed because the implementation cannot be tested" no better than it could
 * tell a review that ran out of steps apart from one that found a real blocker — both pairs need the
 * run's own outcome, not just which stage failed and how many times. That gap is what this card
 * closes for the general case; `testing.onFail: testing` was always the coarser, config-level answer
 * to the same problem for one stage, and stays exactly as coarse.
 *
 * `resultDropped` (`StageOutcome.resultDropped`) is narrower still: it says the stage did report,
 * and the transport lost the result on the way back — nothing was consumed that repeating the
 * attempt would waste. `unjudged` is true for this too, so the routing above is unaffected — the
 * code still was not evaluated, and the retry still targets this stage. What changes is the count:
 * the first `RESULT_DROPPED_ALLOWANCE` such attempts leave `retries[stage.name]` untouched, tracked
 * instead under `droppedRetryKey`; once that allowance is spent, a dropped result starts consuming
 * the same budget any other failure would, via the recursive call below.
 */
export const kickback = (
    stage: StageConfig,
    retries: Record<string, number>,
    unjudged: boolean,
    resultDropped: boolean,
): KickbackDecision => {
    if (resultDropped) {
        const droppedKey = droppedRetryKey(stage);
        const dropped = (retries[droppedKey] ?? 0) + 1;
        const nextRetries = { ...retries, [droppedKey]: dropped };
        if (dropped <= RESULT_DROPPED_ALLOWANCE) {
            // Free retry: the card's own retries[stage.name] is left exactly as it was.
            return { target: stage.name, retries: nextRetries };
        }
        // Allowance spent. Keep the dropped count moving (so a later raise to the allowance cannot
        // retroactively regrant retries already spent this way) and fall through to the ordinary
        // accounting below, which now also charges retries[stage.name] for this attempt.
        return kickback(stage, nextRetries, unjudged, false);
    }

    const attempts = (retries[stage.name] ?? 0) + 1;
    const nextRetries = { ...retries, [stage.name]: attempts };
    if (attempts >= stage.maxKickbacks) {
        return {
            target: stage.name,
            retries: nextRetries,
            needsHuman: { reason: `"${stage.name}" failed ${attempts} time(s), reaching its maxKickbacks cap of ${stage.maxKickbacks}` },
        };
    }
    return { target: unjudged ? stage.name : stage.onFail, retries: nextRetries };
};

/**
 * Whether a finished stage should move the card forward.
 *
 * A passing stage is not the same as an advancing card: a review that returns `verdict: 'revise'`
 * satisfied its own exit condition — it is a well-formed review — but the card must still go
 * backward. A result with no `verdict` field at all, as implementing and testing return, carries
 * nothing that could block advancing.
 */
export const shouldAdvance = (passed: boolean, result: unknown): boolean => {
    if (!passed) return false;
    const verdict = (result as { verdict?: unknown } | null | undefined)?.verdict;
    return verdict !== 'revise';
};
