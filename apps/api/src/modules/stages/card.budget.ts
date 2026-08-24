/**
 * Whether a card has spent its budget across all stages — not this run.
 *
 * Checked before dispatch (card 0018): the point is to refuse work that cannot be afforded, not
 * to discover it once it is spent. Exceeding this is not a kickback — a card that has spent its
 * budget will spend it again on the next attempt, so retrying cannot fix it.
 */
export const cardOverBudget = (spent: number, cap: number | undefined): string | undefined => {
    if (cap === undefined || spent < cap) {
        return undefined;
    }
    return `card has spent its budget across all stages: ${spent} input tokens spent, cap is ${cap}`;
};
