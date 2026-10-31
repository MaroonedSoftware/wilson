import type { StageConfig } from './stage.config.js';

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

/**
 * The stage a run should be handed once `spent` is known: its own `maxInputTokens`, or what is left
 * of the card's ceiling when that is less.
 *
 * `cardOverBudget` only refuses a run before it starts, so without this a card one token under its
 * ceiling could still spend a whole run's budget. A run cut off here fails as a budget failure, and
 * the next dispatch refuses the card.
 */
export const withinCardBudget = (stage: StageConfig, spent: number): StageConfig =>
    stage.maxCardInputTokens === undefined ? stage : { ...stage, maxInputTokens: Math.min(stage.maxInputTokens, stage.maxCardInputTokens - spent) };
