import type { DateTime, Duration } from 'luxon';
import type { CardEventRow } from './event.log.js';

/**
 * How long a card has held its current stage, derived from its event log.
 *
 * The most recent `transition.written` event marks the moment the card entered its current stage.
 * A card that has never transitioned has been in its stage since its first recorded event. A card
 * with no events at all has no answer — returning zero would claim "just arrived", which is a
 * different fact than "unknown".
 *
 * Pure: takes `now` as a parameter rather than reading the clock, so it is testable without
 * freezing time.
 */
export const timeInCurrentStage = (events: CardEventRow[], now: DateTime): Duration | undefined => {
    const [earliest] = events;
    if (!earliest) return undefined;

    const lastTransition = [...events].reverse().find(event => event.type === 'transition.written');
    const since = lastTransition ?? earliest;

    return now.diff(since.createdAt);
};
