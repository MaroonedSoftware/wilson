import type { DateTime, Duration } from 'luxon';
import type { CardEventRow } from './event.log.js';

/**
 * The moment `events`' card entered its current stage.
 *
 * The most recent `transition.written` event marks that moment. A card that has never
 * transitioned has been in its stage since its first recorded event. A card with no events at all
 * has no answer — returning `undefined` rather than guessing keeps "unknown" distinct from "just
 * arrived", which a zero-length gap from `timeInCurrentStage` below would otherwise claim.
 *
 * Card 0178: factored out of `timeInCurrentStage` so `BoardService` can put this same moment on
 * the wire as `CardSummary.stageEnteredAt` without re-deriving it, or reaching for the duration it
 * has no use for.
 */
export const stageEnteredAt = (events: CardEventRow[]): DateTime | undefined => {
    const [earliest] = events;
    if (!earliest) return undefined;

    const lastTransition = [...events].reverse().find(event => event.type === 'transition.written');
    return (lastTransition ?? earliest).createdAt;
};

/**
 * How long a card has held its current stage, derived from its event log.
 *
 * Pure: takes `now` as a parameter rather than reading the clock, so it is testable without
 * freezing time.
 */
export const timeInCurrentStage = (events: CardEventRow[], now: DateTime): Duration | undefined => {
    const since = stageEnteredAt(events);
    return since ? now.diff(since) : undefined;
};
