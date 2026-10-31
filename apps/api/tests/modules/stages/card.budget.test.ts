import { describe, expect, it } from 'vitest';
import { cardOverBudget, withinCardBudget } from '#modules/stages/card.budget.js';
import type { StageConfig } from '#modules/stages/stage.config.js';

/**
 * Card 0018: a per-card ceiling on everything a card has ever spent, across every stage and every
 * attempt — distinct from `maxInputTokens`, which bounds a single run. `cardOverBudget` is the pure
 * predicate the dispatcher calls before cutting a worktree.
 */
describe('cardOverBudget', () => {
    it('is unbounded when no cap is configured, however much has been spent', () => {
        expect(cardOverBudget(0, undefined)).toBeUndefined();
        expect(cardOverBudget(10_000_000, undefined)).toBeUndefined();
    });

    it('returns undefined while spend sits strictly below the cap', () => {
        expect(cardOverBudget(999, 1000)).toBeUndefined();
    });

    it('flags the card once spend reaches the cap exactly — the ceiling is inclusive', () => {
        expect(cardOverBudget(1000, 1000)).toBeDefined();
    });

    it('flags the card once spend exceeds the cap', () => {
        expect(cardOverBudget(1_500_000, 1_000_000)).toBeDefined();
    });

    it('names both the amount spent and the configured cap in the message', () => {
        const message = cardOverBudget(1_500_000, 1_000_000);

        expect(message).toContain('1500000');
        expect(message).toContain('1000000');
    });

    it('describes the ceiling as spent across all stages, not just this run', () => {
        // The distinction from `maxInputTokens` (card 0015) is the whole point of this card — a
        // reader must not mistake this message for a single-run budget failure.
        const message = cardOverBudget(2000, 1000);

        expect(message).toMatch(/across all stages/);
    });
});

describe('withinCardBudget', () => {
    const stage = (overrides: Partial<StageConfig>) => ({ maxInputTokens: 5000, ...overrides }) as StageConfig;

    it('leaves the stage alone when no card ceiling is configured', () => {
        const config = stage({});

        expect(withinCardBudget(config, 10_000_000)).toBe(config);
    });

    it('lowers the run’s cap to what remains of the card’s ceiling', () => {
        expect(withinCardBudget(stage({ maxCardInputTokens: 10_000 }), 9000).maxInputTokens).toBe(1000);
    });

    it('keeps the run’s own cap when the card has more left than that', () => {
        expect(withinCardBudget(stage({ maxCardInputTokens: 10_000 }), 1000).maxInputTokens).toBe(5000);
    });
});
