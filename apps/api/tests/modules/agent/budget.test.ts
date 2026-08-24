import { describe, expect, it } from 'vitest';
import { overBudget, sumInputTokens, tokenBudgetExceeded } from '#modules/agent/budget.js';

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
