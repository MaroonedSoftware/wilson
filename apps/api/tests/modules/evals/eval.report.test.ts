import { describe, expect, it } from 'vitest';
import { orderRuns } from '#modules/evals/eval.batches.service.js';
import { summarizeRuns } from '#modules/evals/eval.report.js';
import type { EvalRunRow } from '#modules/evals/eval.run.repository.js';

const run = (overrides: Partial<EvalRunRow>): EvalRunRow => ({
    id: '1',
    batchId: '1',
    fixtureId: '7',
    arm: 'current',
    position: 0,
    status: 'passed',
    failures: [],
    unjudged: false,
    reportRejected: false,
    truncated: false,
    patchTruncated: false,
    ...overrides,
});

describe('summarizeRuns', () => {
    it('counts each ending per fixture and arm, keeping what says nothing about the config apart', () => {
        const [current, candidate] = summarizeRuns([
            run({ status: 'passed' }),
            run({ status: 'failed', failures: ['build failed'] }),
            run({ status: 'errored' }),
            run({ status: 'interrupted' }),
            run({ status: 'abandoned' }),
            run({ status: 'queued' }),
            run({ arm: 'candidate', status: 'passed' }),
        ]);

        expect(current).toMatchObject({ arm: 'current', passed: 1, failed: 1, errored: 1, interrupted: 2, pending: 1 });
        expect(candidate).toMatchObject({ arm: 'candidate', passed: 1, failed: 0 });
    });

    it('takes spreads only over runs that reached a verdict', () => {
        const [summary] = summarizeRuns([
            run({ outputTokens: 100, wallClockMs: 10 }),
            run({ outputTokens: 300, wallClockMs: 30 }),
            run({ status: 'failed', outputTokens: 200, wallClockMs: 20 }),
            run({ status: 'interrupted', outputTokens: 99999, wallClockMs: 99999 }),
        ]);

        expect(summary!.outputTokens).toEqual({ median: 200, min: 100, max: 300 });
        expect(summary!.wallClockMs).toEqual({ median: 20, min: 10, max: 30 });
    });

    it('averages the middle two for an even count, and leaves a spread out with nothing to measure', () => {
        const [even] = summarizeRuns([run({ outputTokens: 100 }), run({ outputTokens: 201 })]);
        const [none] = summarizeRuns([run({ status: 'queued' })]);

        expect(even!.outputTokens?.median).toBe(151);
        expect(none).not.toHaveProperty('outputTokens');
    });

    it('counts failure reasons, most common first', () => {
        const [summary] = summarizeRuns([run({ status: 'failed', failures: ['a'] }), run({ status: 'failed', failures: ['b', 'a'] })]);

        expect(summary!.failures).toEqual([
            { reason: 'a', count: 2 },
            { reason: 'b', count: 1 },
        ]);
    });
});

describe('orderRuns', () => {
    it('alternates arms within each fixture, so neither arm runs in one long block', () => {
        expect(orderRuns(['1', '2'], ['current', 'candidate'], 2).map(({ fixtureId, arm }) => `${fixtureId}${arm[1]}`)).toEqual([
            '1u',
            '1a',
            '1u',
            '1a',
            '2u',
            '2a',
            '2u',
            '2a',
        ]);
    });
});
