import type { BoardColumns, CardSummary } from '@wilson/sdk';

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
 * Cards per column, flagged first, then lowest id first — ids are sequential, so that is also
 * oldest first within each group. Flagged cards sort to the top of their own column, not the top
 * of the board: the flag is information about the card, not a reason to jump the column queue.
 */
export const groupByStage = (cards: CardSummary[]): Map<string, CardSummary[]> => {
    const grouped = new Map<string, CardSummary[]>();
    for (const card of [...cards].sort((a, b) => Number(b.needsHuman) - Number(a.needsHuman) || a.id.localeCompare(b.id))) {
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
