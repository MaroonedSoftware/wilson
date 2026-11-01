import { describe, expect, it } from 'vitest';
import {
    budgetedInputTokens,
    contextBudgetExceeded,
    overBudget,
    sumInputTokens,
    tokenBudgetExceeded,
    wallClockExceeded,
} from '#modules/agent/budget.js';

/**
 * Card 0015: nothing bounded input tokens before this. One stage consumed 6.3M input tokens while
 * its output cap held it to 50k, because `maxOutputTokens` and `maxSteps` never looked at input at
 * all. This is the one place that arithmetic and its failure message live, shared by both adapters.
 */
describe('sumInputTokens', () => {
    it('is zero for no steps', () => {
        expect(sumInputTokens([])).toBe(0);
    });

    it('adds up input tokens across steps', () => {
        const steps = [{ usage: { inputTokens: 100 } }, { usage: { inputTokens: 250 } }, { usage: { inputTokens: 4 } }];
        expect(sumInputTokens(steps)).toBe(354);
    });

    it('treats a step with no usage as contributing nothing, rather than throwing', () => {
        const steps = [{ usage: { inputTokens: 100 } }, {}, { usage: { inputTokens: 50 } }];
        expect(sumInputTokens(steps)).toBe(150);
    });

    it('treats usage with no inputTokens as contributing nothing', () => {
        const steps = [{ usage: { inputTokens: 100 } }, { usage: {} }];
        expect(sumInputTokens(steps)).toBe(100);
    });
});

describe('tokenBudgetExceeded', () => {
    it('is false while cumulative input tokens sit under the cap', () => {
        const check = tokenBudgetExceeded(1000);
        expect(check({ steps: [{ usage: { inputTokens: 999 } }] })).toBe(false);
    });

    it('is true the moment cumulative input tokens meet the cap exactly', () => {
        // A `stopWhen` condition that only fired once the cap was already exceeded would let one more
        // step's worth of input tokens through past the configured ceiling.
        const check = tokenBudgetExceeded(1000);
        expect(check({ steps: [{ usage: { inputTokens: 1000 } }] })).toBe(true);
    });

    it('is true once cumulative input tokens pass the cap', () => {
        const check = tokenBudgetExceeded(1000);
        expect(check({ steps: [{ usage: { inputTokens: 700 } }, { usage: { inputTokens: 400 } }] })).toBe(true);
    });

    it('sums across every step passed in, not just the last one', () => {
        const check = tokenBudgetExceeded(500);
        const steps = [{ usage: { inputTokens: 100 } }, { usage: { inputTokens: 100 } }, { usage: { inputTokens: 100 } }];
        expect(check({ steps })).toBe(false);
        expect(check({ steps: [...steps, { usage: { inputTokens: 300 } }] })).toBe(true);
    });
});

describe('overBudget', () => {
    it('is undefined when used is under the cap', () => {
        expect(overBudget(999, 1000)).toBeUndefined();
    });

    it('is undefined when used is undefined, whatever the cap', () => {
        // A run whose usage was never reported should not be treated as having blown its budget —
        // there is nothing to compare against.
        expect(overBudget(undefined, 1000)).toBeUndefined();
    });

    it('fires the moment used meets the cap exactly', () => {
        expect(overBudget(1000, 1000)).toBeDefined();
    });

    it('fires once used exceeds the cap', () => {
        expect(overBudget(1500, 1000)).toBeDefined();
    });

    it('names both figures, so an operator does not have to go dig for them', () => {
        expect(overBudget(2_500_000, 2_000_000)).toBe('input token budget exceeded: used 2500000, cap 2000000');
    });
});

/**
 * Card 0093: nothing stopped a stage before it overflowed the context window. `overBudget` only
 * ever sees input tokens a run has already spent; this compares `Query.getContextUsage()`'s own
 * `percentage` — the one number the engine reports that already accounts for what the *next* turn's
 * prompt would carry — against a configured fraction of the window.
 */
describe('contextBudgetExceeded', () => {
    it('is undefined while percentage sits under the cap fraction', () => {
        expect(contextBudgetExceeded(0.9, 89)).toBeUndefined();
    });

    it('fires the moment percentage meets the cap fraction exactly', () => {
        // A check that only fired once already past the cap would let one more beat's worth of
        // usage through before stopping — the same off-by-one `overBudget` guards against.
        expect(contextBudgetExceeded(0.9, 90)).toBeDefined();
    });

    it('fires once percentage exceeds the cap fraction', () => {
        expect(contextBudgetExceeded(0.9, 95)).toBeDefined();
    });

    it('names both the configured cap and the observed percentage', () => {
        expect(contextBudgetExceeded(0.9, 95)).toBe('context window budget exceeded: cap 90% of window, observed 95%');
    });

    it('reflects whatever cap fraction it is given, not a fixed figure', () => {
        expect(contextBudgetExceeded(0.5, 50)).toBe('context window budget exceeded: cap 50% of window, observed 50%');
    });

    it('is worded distinctly from overBudget and wallClockExceeded, so the three causes never read the same', () => {
        const context = contextBudgetExceeded(0.9, 95);
        const tokenBudget = overBudget(1000, 1000);
        const wallClock = wallClockExceeded(1000);
        expect(context).toContain('context window');
        expect(context).not.toBe(tokenBudget);
        expect(context).not.toBe(wallClock);
    });
});

describe('wallClockExceeded', () => {
    // A wall-clock abort fires at the cap itself, so there is no smaller "actual" figure the way
    // `overBudget` has one — the message names the cap and, distinctly from `overBudget`'s wording,
    // identifies the cause as the wall clock rather than the input-token budget. Reviewer feedback on
    // this card was specifically that a timeout getting reported as step exhaustion sends an operator
    // to raise the wrong number, so the message text itself is worth pinning down.
    it('names the maxWallClockMs cap that was hit', () => {
        expect(wallClockExceeded(1_800_000)).toBe('wall-clock budget exceeded: cap 1800000ms');
    });

    it('reflects whatever cap it is given, not a fixed figure', () => {
        expect(wallClockExceeded(42_000)).toBe('wall-clock budget exceeded: cap 42000ms');
    });

    it('is worded distinctly from overBudget, so the two causes never read the same', () => {
        const wallClock = wallClockExceeded(1000);
        const tokenBudget = overBudget(1000, 1000);
        expect(wallClock).not.toBe(tokenBudget);
        expect(wallClock).toContain('wall-clock');
        expect(tokenBudget).toContain('input token');
    });
});

describe('budgetedInputTokens', () => {
    it('counts cached tokens alongside uncached ones', () => {
        expect(budgetedInputTokens({ inputTokens: 6, cachedInputTokens: 195_286 })).toBe(195_292);
    });

    it('counts what a usage holds when it has no cached figure', () => {
        expect(budgetedInputTokens({ inputTokens: 900 })).toBe(900);
    });

    it('has nothing to count when no usage was reported', () => {
        expect(budgetedInputTokens(undefined)).toBeUndefined();
        expect(budgetedInputTokens({})).toBeUndefined();
    });
});
