import { describe, expect, it } from 'vitest';
import { StageConfigSchema } from '#modules/stages/stage.config.js';

/**
 * Card 0015 added budget caps to the stage schema: `maxInputTokens`, `maxWallClockMs` and
 * `maxBudgetUsd`. Nothing bounded input tokens or wall-clock before this card.
 */
const minimalStage = {
    name: 'implementing',
    mode: 'agent' as const,
    model: 'claude-opus',
    instructions: 'do the thing',
    onPass: 'review',
    onFail: 'implementing',
};

describe('StageConfigSchema budget fields', () => {
    it('defaults maxInputTokens to 2,000,000 when omitted', () => {
        const stage = StageConfigSchema.parse(minimalStage);
        expect(stage.maxInputTokens).toBe(2_000_000);
    });

    it('defaults maxWallClockMs to 1,800,000 (30 minutes) when omitted', () => {
        const stage = StageConfigSchema.parse(minimalStage);
        expect(stage.maxWallClockMs).toBe(1_800_000);
    });

    it('leaves maxBudgetUsd unset when omitted, rather than defaulting it', () => {
        // Cost in currency is not a thing the `api` adapter tracks — tokens are its unit. `cli` is
        // the only engine that can enforce a dollar ceiling, so an unset value must mean "no
        // ceiling", not "zero".
        const stage = StageConfigSchema.parse(minimalStage);
        expect(stage.maxBudgetUsd).toBeUndefined();
    });

    it('accepts an explicit maxInputTokens, maxWallClockMs and maxBudgetUsd', () => {
        const stage = StageConfigSchema.parse({ ...minimalStage, maxInputTokens: 500_000, maxWallClockMs: 60_000, maxBudgetUsd: 5 });
        expect(stage.maxInputTokens).toBe(500_000);
        expect(stage.maxWallClockMs).toBe(60_000);
        expect(stage.maxBudgetUsd).toBe(5);
    });

    it('rejects a maxInputTokens below the 1000 floor', () => {
        expect(() => StageConfigSchema.parse({ ...minimalStage, maxInputTokens: 500 })).toThrow();
    });

    it('rejects a maxWallClockMs below the 1000 floor', () => {
        expect(() => StageConfigSchema.parse({ ...minimalStage, maxWallClockMs: 500 })).toThrow();
    });

    it('rejects a maxBudgetUsd of zero, since it must be strictly positive', () => {
        expect(() => StageConfigSchema.parse({ ...minimalStage, maxBudgetUsd: 0 })).toThrow();
    });

    it('rejects a negative maxBudgetUsd', () => {
        expect(() => StageConfigSchema.parse({ ...minimalStage, maxBudgetUsd: -5 })).toThrow();
    });
});
