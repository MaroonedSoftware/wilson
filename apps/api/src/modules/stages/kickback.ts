import type { StageConfig } from '#modules/stages/stage.config.js';

export interface KickbackDecision {
    /** The stage the card moves to. */
    target: string;
    /** The card's retry counters, with this stage's incremented. */
    retries: Record<string, number>;
}

/**
 * Decide where a card goes when `stage` fails, and count the attempt.
 *
 * The counter is per stage: incrementing `stage.name`'s count never touches any other stage's.
 * Once that count reaches `maxKickbacks`, the stage has failed as many times as it is allowed to
 * and the card routes to `needs-human` instead of retrying again.
 */
export const kickback = (stage: StageConfig, retries: Record<string, number>): KickbackDecision => {
    const attempts = (retries[stage.name] ?? 0) + 1;
    const nextRetries = { ...retries, [stage.name]: attempts };
    const target = attempts >= stage.maxKickbacks ? 'needs-human' : stage.onFail;
    return { target, retries: nextRetries };
};
