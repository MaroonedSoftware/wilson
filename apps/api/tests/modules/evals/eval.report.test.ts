import { describe, expect, it } from 'vitest';
import { orderRuns } from '#modules/evals/eval.batches.service.js';
import type { EvalExpected } from '#modules/evals/eval.attempt.js';
import { scoreRun, summarizeRuns, totalRuns } from '#modules/evals/eval.report.js';
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

describe('scoreRun', () => {
    const revise: EvalExpected = { verdict: 'revise', blockerFiles: ['a.ts'], source: 'operator' };
    const pass: EvalExpected = { verdict: 'pass', blockerFiles: [], source: 'operator' };
    const reviewed = (verdict: string, ...files: string[]) =>
        run({ result: { verdict, findings: files.map(file => ({ severity: 'blocker', file })) } });

    it('tells a caught blocker from one named somewhere else, and from a pass', () => {
        expect(scoreRun(revise, reviewed('revise', 'a.ts'))).toBe('caught');
        expect(scoreRun(revise, reviewed('revise', 'b.ts'))).toBe('missed');
        expect(scoreRun(revise, reviewed('pass'))).toBe('missed');
    });

    it('counts any blocker as caught when none is named', () => {
        expect(scoreRun({ ...revise, blockerFiles: [] }, reviewed('revise', 'b.ts'))).toBe('caught');
    });

    it('tells a clean pass from a false alarm', () => {
        expect(scoreRun(pass, reviewed('pass'))).toBe('clean');
        expect(scoreRun(pass, reviewed('revise', 'a.ts'))).toBe('falseAlarms');
    });

    it('scores neither a report the runner threw out nor a run with no conclusion', () => {
        expect(scoreRun(revise, { ...reviewed('revise', 'a.ts'), unjudged: true })).toBe('unscored');
        expect(scoreRun(revise, run({}))).toBe('unscored');
    });

    it('means a review that passes everything cannot score well', () => {
        const expected = new Map<string, EvalExpected>([
            ['1', revise],
            ['2', pass],
        ]);
        const runs = [
            { ...reviewed('pass'), fixtureId: '1' },
            { ...reviewed('pass'), fixtureId: '2' },
        ];

        expect(totalRuns(runs, expected)[0]!.score).toMatchObject({ caught: 0, missed: 1, clean: 1 });
    });

    it('leaves the score out of a fixture that expects nothing, and leaves unfinished runs uncounted', () => {
        expect(summarizeRuns([run({})])[0]).not.toHaveProperty('score');
        const [summary] = summarizeRuns([{ ...reviewed('pass'), status: 'interrupted' }], new Map([['7', revise]]));
        expect(summary!.score).toEqual({ caught: 0, missed: 0, falseAlarms: 0, clean: 0, unscored: 0 });
    });
});
