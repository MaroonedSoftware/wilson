import type { DateTime } from 'luxon';
import type { BoardColumns, CardSummary } from '@wilson/sdk';
import type { CardState } from '#src/components/brand/StateIcon.js';
import type { CardActivity } from './feed.js';

/** The column cards wait in before anyone promotes them. Not a stage — dispatch excludes it. */
export const PARKING_LOT = 'parking-lot';

/**
 * The columns to render, left to right: the parking lot, then the configured stages in the order
 * they run, then the terminal states.
 *
 * Any stage a card actually sits in but the config does not name is appended rather than dropped. A
 * card that appears nowhere makes the board quietly disagree with the database, which is a worse
 * failure than an unexpected column — and the states most likely to arrive this way, `poisoned`
 * among them, are exactly the ones somebody needs to see.
 */
export const columnOrder = (columns: BoardColumns, cards: CardSummary[]): string[] => {
    const terminal = columns.nonStages.filter(state => state !== PARKING_LOT);
    const known = [PARKING_LOT, ...columns.stages, ...terminal];
    const unknown = [...new Set(cards.map(card => card.stage))].filter(stage => !known.includes(stage)).sort();
    return [...known, ...unknown];
};

/**
 * The parking lot's own order: lowest `position` first, matching `ORDER BY position, id`
 * (`PostgresBoardRepository.list`) where Postgres sorts a null `position` after every non-null one —
 * a card nothing has ever dragged (including every card that predates card 0091, which back-filled
 * nothing) falls back to id among the others like it, not to either end of the column.
 */
const byPositionThenId = (a: CardSummary, b: CardSummary): number => {
    if (a.position != null && b.position != null) return a.position - b.position;
    if (a.position != null) return -1;
    if (b.position != null) return 1;
    return a.id.localeCompare(b.id);
};

/**
 * Cards per column. Every column but the parking lot sorts flagged first, then lowest id first —
 * ids are sequential, so that is also oldest first within each group. Flagged cards sort to the top
 * of their own column, not the top of the board: the flag is information about the card, not a
 * reason to jump the column queue.
 *
 * The parking lot sorts by `position` instead (see `byPositionThenId`), flagged or not — card 0047's
 * plan: an operator's drag is the order there, and a flagged card that always jumped to the top
 * regardless of where it was dropped would make half the column undraggable.
 */
export const groupByStage = (cards: CardSummary[]): Map<string, CardSummary[]> => {
    const grouped = new Map<string, CardSummary[]>();
    const sorted = [...cards].sort((a, b) =>
        a.stage === PARKING_LOT && b.stage === PARKING_LOT
            ? byPositionThenId(a, b)
            : Number(b.needsHuman) - Number(a.needsHuman) || a.id.localeCompare(b.id),
    );
    for (const card of sorted) {
        grouped.set(card.stage, [...(grouped.get(card.stage) ?? []), card]);
    }
    return grouped;
};

/**
 * Which of a card's dependencies have not finished.
 *
 * Finished means `merged`, matching the runner's own rule in `next.card.ts` — and deliberately not
 * matching `wilson card list`, which labels a card blocked whenever `dependsOn` is non-empty
 * whether or not the dependency landed. A dependency on a card missing from the board entirely
 * counts as unfinished, never as fine. A split origin also counts as finished once it has pieces and
 * every one of them is finished, whatever stage the origin sits in.
 */
export const unfinishedDeps = (card: CardSummary, cards: CardSummary[]): string[] => {
    const byId = new Map(cards.map(c => [c.id, c]));
    const isFinished = (id: string): boolean => {
        const dep = byId.get(id);
        if (dep === undefined) return false;
        if (dep.stage === 'merged') return true;
        const pieces = cards.filter(c => c.splitFrom === id);
        return pieces.length > 0 && pieces.every(piece => isFinished(piece.id));
    };
    return card.dependsOn.filter(id => !isFinished(id));
};

export const stagesById = (cards: CardSummary[]): Map<string, string> => new Map(cards.map(card => [card.id, card.stage]));

/**
 * Which of `StateIcon`'s six faces a board tile should show for `card`, or `undefined` for a
 * plain in-flight stage — which gets no face at all rather than a guessed one. Conservative on
 * purpose (this card's plan, Constraints): only the four claims `CardSummary` can actually prove
 * appear here. `needsHuman` overrides the stage entirely, so a flagged card reads as needing a
 * human regardless of what stage it happens to be sitting in. There is deliberately no `running`
 * face — nothing on the wire says a job is actively working a card right now, and faking that from
 * stage would claim more than the data supports.
 */
export const cardState = (card: CardSummary): CardState | undefined => {
    if (card.needsHuman) return 'needs-human';
    if (card.stage === PARKING_LOT) return 'parked';
    if (card.stage === 'poisoned') return 'poisoned';
    if (card.stage === 'merged') return 'passed';
    return undefined;
};

/**
 * The `localStorage` key a project's collapsed-column set lives under (Card 0183). One place that
 * spells it out, so `Board.tsx` and its tests read the same key rather than each hard-coding their
 * own copy that could drift apart.
 */
export const collapsedColumnsKey = (project: string): string => `wilson:collapsed-columns:${project}`;

/**
 * Card 0183: flips `stage`'s membership in `collapsed` — added if absent, removed if present —
 * without mutating the input array, matching `useLocalStorage`'s updater-function form
 * (`setCollapsed(current => toggleCollapsed(current, stage))`).
 *
 * Deliberately does not prune a stage the config no longer names: a stored entry that matches no
 * rendered column is simply inert, whereas pruning would silently forget a collapse the moment a
 * `stages.yaml` reload dropped and re-added the same stage.
 */
export const toggleCollapsed = (collapsed: readonly string[], stage: string): string[] =>
    collapsed.includes(stage) ? collapsed.filter(entry => entry !== stage) : [...collapsed, stage];

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * The dimmed "3d in stage" line a board tile shows below its badges — how long `card` has held
 * its current stage, as of `now` (a parameter rather than a read of the clock, so this stays pure
 * and testable). Callers render it only when `stageEnteredAt` is present (see `CardBody` in
 * `Board.tsx`) — omitting the line rather than guessing a duration, matching `stageEnteredAt`'s own
 * contract (card 0178).
 */
export const ageInStage = (stageEnteredAt: DateTime, now: Date): string => {
    const elapsed = Math.max(0, now.getTime() - stageEnteredAt.toMillis());
    if (elapsed < HOUR_MS) return `${Math.round(elapsed / MINUTE_MS)}m in stage`;
    if (elapsed < DAY_MS) return `${Math.round(elapsed / HOUR_MS)}h in stage`;
    return `${Math.round(elapsed / DAY_MS)}d in stage`;
};

const SECOND_MS = 1000;

/**
 * Card 0274. Past this age, a board tile's "last event" line renders in its stale style (AC4) — five
 * minutes, matching card 0204's proposed idle watchdog so the two agree if that lands (this card's
 * Constraints). One named constant, read by both `Board.tsx` (for the style) and whichever test
 * exercises the threshold, rather than the figure copied in each place.
 */
export const LAST_EVENT_STALE_MS = 5 * 60_000;

/**
 * Card 0274. How long ago `ts` — a feed event's own publish time, never the browser's receipt time
 * (AC3) — was, as of `now`. Seconds-level for the first minute (a board tile updates on
 * `ACTIVITY_TICK_MS`'s ten-second beat, so "0m ago" would sit unchanged for most of that window),
 * then the same "Xh"/"Xd" rounding `ageInStage` already uses above.
 */
export const lastEventAge = (ts: string, now: Date): string => {
    const elapsed = Math.max(0, now.getTime() - new Date(ts).getTime());
    if (elapsed < MINUTE_MS) return `${Math.round(elapsed / SECOND_MS)}s ago`;
    if (elapsed < HOUR_MS) return `${Math.round(elapsed / MINUTE_MS)}m ago`;
    if (elapsed < DAY_MS) return `${Math.round(elapsed / HOUR_MS)}h ago`;
    return `${Math.round(elapsed / DAY_MS)}d ago`;
};

/**
 * Card 0274's own display rule (Constraints): a board tile shows its "last event" line only while
 * `activity` — the card's latest feed event, `useCardActivity` — is `stage.dispatched` or a `tool.*`
 * event, and only when that event's own `stage` still matches `cardStage`. The stage check keeps a
 * lingering event from a stage the card has since left from reading as live: `stage.dispatched`
 * fires on entering a stage, and a `tool.*` event is always recorded in the stage it ran in
 * (`card.event.ts`), so either naming a different stage than the card's current one means the card
 * has since moved on and this event is stale in a way `lastEventAge` alone can't say (AC5).
 */
export const showsLastEventLine = (activity: CardActivity | undefined, cardStage: string): boolean =>
    activity !== undefined && activity.stage === cardStage && (activity.type === 'stage.dispatched' || activity.type.startsWith('tool.'));
