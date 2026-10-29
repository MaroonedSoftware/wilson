import type { DateTime, Duration } from 'luxon';
import type { CardEventRow } from './event.log.js';

/**
 * The moment `events`' card entered its current stage.
 *
 * The most recent `transition.written` event marks that moment. A card that has never
 * transitioned has been in its stage since its first recorded event — but only when `events` is
 * known to be the card's *complete* log (`fullHistory: true`, the default). A caller that instead
 * hands over a bounded tail (`EventLog.tail`'s `limit`) can find no `transition.written` event in
 * it for two very different reasons: the card genuinely never transitioned, or the window simply
 * ends before reaching one — a stage that has piled up enough other events (an agent's tool calls,
 * say) since its last transition can push that event out of even a generous lookback. Those two
 * cases must not answer alike: falling back to the window's earliest event in the second case
 * would present a wrong, too-recent timestamp as fact. `fullHistory: false` is how such a caller
 * says "this might be exactly that truncated case", so the fallback answers `undefined` instead of
 * guessing. A card with no events at all has no answer either way — returning `undefined` rather
 * than guessing keeps "unknown" distinct from "just arrived", which a zero-length gap from
 * `timeInCurrentStage` below would otherwise claim.
 *
 * Card 0178: factored out of `timeInCurrentStage` so `BoardService` can put this same moment on
 * the wire as `CardSummary.stageEnteredAt` without re-deriving it, or reaching for the duration it
 * has no use for.
 */
export const stageEnteredAt = (events: CardEventRow[], opts: { fullHistory?: boolean } = {}): DateTime | undefined => {
    const [earliest] = events;
    if (!earliest) return undefined;

    const lastTransition = [...events].reverse().find(event => event.type === 'transition.written');
    if (lastTransition) return lastTransition.createdAt;

    return (opts.fullHistory ?? true) ? earliest.createdAt : undefined;
};

/**
 * How long a card has held its current stage, derived from its event log.
 *
 * Pure: takes `now` as a parameter rather than reading the clock, so it is testable without
 * freezing time. `fullHistory` forwards to `stageEnteredAt` unchanged — see there for why a
 * bounded tail needs to say so.
 */
export const timeInCurrentStage = (events: CardEventRow[], now: DateTime, opts: { fullHistory?: boolean } = {}): Duration | undefined => {
    const since = stageEnteredAt(events, opts);
    return since ? now.diff(since) : undefined;
};
