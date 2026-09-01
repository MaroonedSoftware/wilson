import type { BoardColumns, CardSummary } from '@wilson/sdk';
import type { CardState } from '#src/components/brand/StateIcon.js';

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
 * counts as unfinished, never as fine.
 */
export const unfinishedDeps = (card: CardSummary, stageById: Map<string, string>): string[] =>
    card.dependsOn.filter(id => stageById.get(id) !== 'merged');

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
export const ageInStage = (stageEnteredAt: string, now: Date): string => {
    const elapsed = Math.max(0, now.getTime() - new Date(stageEnteredAt).getTime());
    if (elapsed < HOUR_MS) return `${Math.round(elapsed / MINUTE_MS)}m in stage`;
    if (elapsed < DAY_MS) return `${Math.round(elapsed / HOUR_MS)}h in stage`;
    return `${Math.round(elapsed / DAY_MS)}d in stage`;
};
