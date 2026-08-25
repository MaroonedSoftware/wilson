import type { StageConfig } from '#modules/stages/stage.config.js';

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
 */
export const kickback = (stage: StageConfig, retries: Record<string, number>, unjudged: boolean): KickbackDecision => {
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
