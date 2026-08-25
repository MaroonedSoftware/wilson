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
 * `stage.onFail` is what decides the target here, and that is deliberate: the target is a property
 * of the stage that failed, chosen for who can fix it — see the `onFail` field in `stage.config.ts`
 * for the reasoning (card 0060). This function treats a self-targeting `onFail` as nothing special;
 * `target === stage.onFail` is returned the same way regardless of whether that equals `stage.name`,
 * and the maxKickbacks/needsHuman bookkeeping below does not care why the stage failed, only that it
 * did — a self-loop retries and eventually flags a human exactly like a kickback to any other stage.
 *
 * One distinction this function does *not* make: an empty-diff failure (a stage that ran, changed
 * nothing, and was not asked to) is not the same failure as one that tried and produced a bad diff,
 * and in principle those could route differently — flag a human on the first empty diff rather than
 * spend the full `maxKickbacks` retrying something that cannot change. `kickback` cannot make that
 * call itself: it only ever sees `stage` and the retry counters, never the run's outcome, which is
 * where "the diff was empty" actually lives. Wiring that through means the caller
 * (`StageDispatcher.writeTransition`) has to pass it, which this card left alone — routing
 * `testing.onFail: testing` already removes the concrete harm from card 0060, since `implementing`
 * is never re-dispatched with nothing to do. Left as a documented option, not a silent omission.
 */
export const kickback = (stage: StageConfig, retries: Record<string, number>): KickbackDecision => {
    const attempts = (retries[stage.name] ?? 0) + 1;
    const nextRetries = { ...retries, [stage.name]: attempts };
    if (attempts >= stage.maxKickbacks) {
        return {
            target: stage.name,
            retries: nextRetries,
            needsHuman: { reason: `"${stage.name}" failed ${attempts} time(s), reaching its maxKickbacks cap of ${stage.maxKickbacks}` },
        };
    }
    return { target: stage.onFail, retries: nextRetries };
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
