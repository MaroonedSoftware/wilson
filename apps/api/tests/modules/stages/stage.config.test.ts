import { describe, expect, it } from 'vitest';
import { StageConfigSchema, MAX_STAGE_WALL_CLOCK_MS } from '#modules/stages/stage.config.js';
import { CARD_STAGE_EXPIRES_IN } from '#modules/jobs/jobs.module.js';

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

    it('defaults the idle window below the wall clock, so a tight time budget does not carry an unreachable guard', () => {
        const tight = StageConfigSchema.parse({ ...minimalStage, maxWallClockMs: 60_000 });
        expect(tight.maxIdleMs).toBe(60_000);

        const roomy = StageConfigSchema.parse({ ...minimalStage, maxWallClockMs: 1_800_000 });
        expect(roomy.maxIdleMs).toBe(300_000);
    });

    it('refuses an explicit idle window that can never fire before the wall clock', () => {
        // Dead config that reads like a working guard, which is the failure worth catching.
        expect(() => StageConfigSchema.parse({ ...minimalStage, maxWallClockMs: 60_000, maxIdleMs: 60_000 })).toThrow(/maxIdleMs/);
        expect(() => StageConfigSchema.parse({ ...minimalStage, maxWallClockMs: 60_000, maxIdleMs: 90_000 })).toThrow(/maxIdleMs/);
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

    /**
     * Card 0030. A stage that can outlive the job carrying it gets that job expired and redelivered
     * while the first attempt is still running — two agents, one worktree, one branch. Config load is
     * the only place that can be caught before it happens, so the ceiling is a schema rule rather
     * than a convention.
     */
    it('rejects a maxWallClockMs that could outlive the job carrying the stage', () => {
        expect(() => StageConfigSchema.parse({ ...minimalStage, maxWallClockMs: MAX_STAGE_WALL_CLOCK_MS + 1 })).toThrow();
    });

    it('accepts a maxWallClockMs sitting exactly on the ceiling', () => {
        expect(StageConfigSchema.parse({ ...minimalStage, maxWallClockMs: MAX_STAGE_WALL_CLOCK_MS }).maxWallClockMs).toBe(MAX_STAGE_WALL_CLOCK_MS);
    });

    it('leaves the queue expiry with headroom over the longest stage a config can ask for', () => {
        // The job covers more than the run: the worktree, the install, verification and the
        // transition all happen inside it. Equal values would leave none of that room.
        expect(CARD_STAGE_EXPIRES_IN.toMillis()).toBeGreaterThan(MAX_STAGE_WALL_CLOCK_MS);
    });

    it('rejects a maxBudgetUsd of zero, since it must be strictly positive', () => {
        expect(() => StageConfigSchema.parse({ ...minimalStage, maxBudgetUsd: 0 })).toThrow();
    });

    it('rejects a negative maxBudgetUsd', () => {
        expect(() => StageConfigSchema.parse({ ...minimalStage, maxBudgetUsd: -5 })).toThrow();
    });
});

/**
 * Card 0093 added `maxContextWindowFraction`: a stage stops itself once `Query.getContextUsage()`'s
 * `percentage` crosses this fraction of the model's context window, distinct from `maxInputTokens`
 * because a run can be well under its cumulative token budget and still overflow on a single turn.
 */
describe('StageConfigSchema maxContextWindowFraction', () => {
    it('defaults to 0.9 when omitted', () => {
        const stage = StageConfigSchema.parse(minimalStage);
        expect(stage.maxContextWindowFraction).toBe(0.9);
    });

    it('accepts an explicit fraction', () => {
        const stage = StageConfigSchema.parse({ ...minimalStage, maxContextWindowFraction: 0.5 });
        expect(stage.maxContextWindowFraction).toBe(0.5);
    });

    it('accepts a fraction of exactly 1, the top of the window', () => {
        const stage = StageConfigSchema.parse({ ...minimalStage, maxContextWindowFraction: 1 });
        expect(stage.maxContextWindowFraction).toBe(1);
    });

    it('rejects a fraction of zero, since it must be strictly positive', () => {
        expect(() => StageConfigSchema.parse({ ...minimalStage, maxContextWindowFraction: 0 })).toThrow();
    });

    it('rejects a negative fraction', () => {
        expect(() => StageConfigSchema.parse({ ...minimalStage, maxContextWindowFraction: -0.1 })).toThrow();
    });

    it('rejects a fraction above 1, since it names a fraction of the window, not a percentage', () => {
        expect(() => StageConfigSchema.parse({ ...minimalStage, maxContextWindowFraction: 1.1 })).toThrow();
    });
});

/**
 * Card 0018 added `maxCardInputTokens`: a ceiling on everything a card has ever spent, across every
 * stage and every attempt — distinct from `maxInputTokens`, which bounds one run. Absent config must
 * mean unbounded, exactly as every other budget field here already behaves.
 */
describe('StageConfigSchema maxCardInputTokens', () => {
    it('leaves maxCardInputTokens unset when omitted, rather than defaulting it', () => {
        const stage = StageConfigSchema.parse(minimalStage);
        expect(stage.maxCardInputTokens).toBeUndefined();
    });

    it('accepts an explicit maxCardInputTokens', () => {
        const stage = StageConfigSchema.parse({ ...minimalStage, maxCardInputTokens: 5_000_000 });
        expect(stage.maxCardInputTokens).toBe(5_000_000);
    });

    it('rejects a maxCardInputTokens below the 1000 floor', () => {
        expect(() => StageConfigSchema.parse({ ...minimalStage, maxCardInputTokens: 500 })).toThrow();
    });

    it('rejects a non-integer maxCardInputTokens', () => {
        expect(() => StageConfigSchema.parse({ ...minimalStage, maxCardInputTokens: 1000.5 })).toThrow();
    });
});
