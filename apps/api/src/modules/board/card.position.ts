/**
 * Card 0091. Sparse-integer ranking for the parking lot's `position` column.
 *
 * `position` is `integer` and stays one (no migration to fractional ranking), so a card dropped
 * between two neighbours gets the integer midpoint between them rather than a fraction. Pure — no
 * repository, no database — so the "the gap is exhausted" case is reachable and testable without
 * standing up a board, the same reasoning `scopeOverlap` and `nextCard` give for living outside a
 * service.
 */

/**
 * The gap a fresh renormalise leaves between neighbours.
 *
 * Every drop between the same two neighbours halves the gap left between them (the midpoint), so a
 * gap of `G` survives `floor(log2(G))` drops in the same spot before {@link rankBetween} reports
 * there is no integer left and the column needs renormalising again. 1024 gives ten of those before
 * a renormalise, while keeping a fully renormalised column's largest position (`cards * 1024`) far
 * under `integer`'s ~2.1 billion ceiling even for a parking lot in the hundreds of thousands of
 * cards — headroom this column will not need, spent once so the common case (rank, don't
 * renormalise) stays cheap.
 */
export const POSITION_GAP = 1024;

/**
 * The result of ranking a card between two neighbours: either the integer to give it, or a report
 * that no integer separates the two positions passed in, so the caller must renormalise the column
 * (see {@link renormalizedPositions}) and rank again against the fresh values.
 */
export type Ranked = { ok: true; position: number } | { ok: false };

/**
 * Where a card lands between `before` and `after`, the positions of the neighbours it falls between
 * — `undefined` for a side with no neighbour, i.e. the top or bottom of the column, not to be
 * confused with a neighbour that exists but has never been positioned (the caller's job to tell
 * apart: an unpositioned neighbour has nothing to rank against either, and belongs behind a
 * renormalise the same as an exhausted gap, not passed in here as a number).
 *
 * Both absent ranks as though the column were empty — the one card there is the top and the bottom
 * of it at once, so it is given breathing room on both sides rather than being pinned to zero.
 */
export const rankBetween = (before: number | undefined, after: number | undefined): Ranked => {
    if (before === undefined && after === undefined) {
        return { ok: true, position: POSITION_GAP };
    }
    if (before === undefined) {
        return { ok: true, position: after! - POSITION_GAP };
    }
    if (after === undefined) {
        return { ok: true, position: before + POSITION_GAP };
    }

    const midpoint = Math.floor((before + after) / 2);
    if (midpoint <= before || midpoint >= after) {
        return { ok: false };
    }
    return { ok: true, position: midpoint };
};

/**
 * Fresh, evenly spaced positions for a column, in the order the caller wants them to sort — the
 * renormalise pass {@link rankBetween} sends a caller to when it reports no integer is left between
 * two neighbours, and equally what turns a column of never-positioned (`null`) cards into one
 * {@link rankBetween} can rank against, without moving any of them: `order` is expected to already be
 * the column's current sort (`position, id` — `PostgresBoardRepository.list`), so a card with no
 * position keeps the place its `id` gave it, it is just no longer `null` doing the sorting.
 *
 * One-indexed by {@link POSITION_GAP} rather than zero-indexed, so the first card sits a full gap
 * above zero — room to insert above it later without a negative position, which is otherwise fine
 * but needless to invite on the most common insert (dragging something to the top).
 */
export const renormalizedPositions = (order: readonly string[]): Map<string, number> => {
    return new Map(order.map((id, index) => [id, (index + 1) * POSITION_GAP]));
};
