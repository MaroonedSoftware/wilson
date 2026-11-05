import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EvalBatchDetail } from '@wilson/sdk';
import { buildCtx, fetchMock, jsonResponse, methodOf, reasonResponse, urlOf, type Handler } from './sdk-fetch.helper.js';

const { default: run } = await import('../../../../packages/cli/src/commands/eval/run.command.js');
const { renderBatch } = await import('../../../../packages/cli/src/commands/eval/report.js');

const detail = (): EvalBatchDetail =>
    ({
        batch: {
            id: '3',
            status: 'running',
            host: 'my-mac',
            runsPerFixture: 2,
            maxOutputTokens: 1000,
            spentOutputTokens: 200,
            createdAt: '2026-11-05T00:00:00.000Z',
        },
        runs: [
            {
                id: '1',
                fixtureId: '7',
                arm: 'current',
                status: 'failed',
                failures: ['build failed'],
                unjudged: false,
                reportRejected: false,
                truncated: false,
                hasPatch: true,
            },
            {
                id: '2',
                fixtureId: '7',
                arm: 'current',
                status: 'errored',
                failures: [],
                unjudged: false,
                reportRejected: false,
                truncated: false,
                hasPatch: false,
                error: 'setup failed',
            },
        ],
        totals: [{ arm: 'current', passed: 1, failed: 1, errored: 1, interrupted: 0, pending: 0 }],
        summary: [
            {
                fixtureId: '7',
                arm: 'current',
                passed: 1,
                failed: 1,
                errored: 1,
                interrupted: 0,
                pending: 0,
                outputTokens: { median: 100, min: 90, max: 110 },
                wallClockMs: { median: 60000, min: 30000, max: 90000 },
                failures: [{ reason: 'build failed', count: 1 }],
            },
        ],
    }) as unknown as EvalBatchDetail;

describe('wilson eval run', () => {
    it('splits the fixture list and starts the batch', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(detail(), 201));
        const { ctx } = buildCtx();

        const result = await (run.run as unknown as Handler)({ host: 'my-mac', runs: 2 }, ctx, ['7, 8']);

        expect(result).toBe(0);
        expect(urlOf(fetchMock.mock.calls[0]!)).toContain('/api/evals/batches');
        expect(methodOf(fetchMock.mock.calls[0]!)).toBe('POST');
        expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))).toEqual({ fixtureIds: ['7', '8'], host: 'my-mac', runs: 2 });
    });

    it('prints the API’s reason for a refusal', async () => {
        fetchMock.mockResolvedValueOnce(reasonResponse(404, 'no host named "nope"'));
        const { ctx, logger } = buildCtx();

        expect(await (run.run as unknown as Handler)({ host: 'nope' }, ctx, ['7'])).toBe(1);
        expect(logger.error).toHaveBeenCalledWith('no host named "nope"');
    });
});

describe('wilson eval run --candidate', () => {
    it('sends the candidate the file describes', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'eval-candidate-'));
        const file = join(dir, 'candidate.yaml');
        await writeFile(file, 'lane: review\ninstructions: |\n  look harder\nsettings:\n  maxSteps: 80\n');
        fetchMock.mockResolvedValueOnce(jsonResponse(detail(), 201));
        const { ctx } = buildCtx();

        await (run.run as unknown as Handler)({ host: 'my-mac', candidate: file }, ctx, ['7']);

        expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body)).candidate).toEqual({
            lane: 'review',
            instructions: 'look harder\n',
            settings: { maxSteps: 80 },
        });
    });
});

describe('renderBatch', () => {
    it('shows both arms of a fixture, the change and a total, and names no winner', () => {
        const base = detail();
        const summary = [
            { fixtureId: '7', arm: 'current', passed: 2, failed: 1, errored: 0, interrupted: 0, pending: 0, failures: [] },
            { fixtureId: '7', arm: 'candidate', passed: 3, failed: 0, errored: 0, interrupted: 0, pending: 0, failures: [] },
            { fixtureId: '8', arm: 'current', passed: 1, failed: 0, errored: 0, interrupted: 0, pending: 0, failures: [] },
        ];
        const text = renderBatch({
            ...base,
            batch: { ...base.batch, candidate: { lane: 'review', model: 'other' } },
            summary,
            totals: [
                { arm: 'current', passed: 3, failed: 1, errored: 0, interrupted: 0, pending: 0 },
                { arm: 'candidate', passed: 3, failed: 0, errored: 0, interrupted: 0, pending: 0 },
            ],
        } as unknown as EvalBatchDetail);

        expect(text).toContain('candidate: review, changing model');
        expect(text).toMatch(/current\s+passed 2\/3/);
        expect(text).toMatch(/candidate\s+passed 3\/3/);
        expect(text).toContain('all fixtures');
        expect(text).toMatch(/current\s+passed 3\/4/);
        expect(text.toLowerCase()).not.toMatch(/winner|better|worse|significant/);
    });

    it('prints a review score under its arm', () => {
        const base = detail();
        const score = { caught: 2, missed: 1, falseAlarms: 0, clean: 3, unscored: 1 };
        const text = renderBatch({ ...base, summary: [{ ...base.summary[0]!, score }] });

        expect(text).toContain('review: caught 2, missed 1, false alarms 0, clean 3, 1 unscored');
    });

    it('calls a candidate that changes nothing an A/A batch', () => {
        const base = detail();
        const text = renderBatch({ ...base, batch: { ...base.batch, candidate: { lane: 'review' } } } as unknown as EvalBatchDetail);

        expect(text).toContain('changing nothing (A/A)');
    });

    it('reports counts, spreads, reasons and runs with no verdict, and names no winner', () => {
        const text = renderBatch(detail());

        expect(text).toContain('passed 1/2');
        expect(text).toContain('output 100 (90-110)');
        expect(text).toContain('time 60s (30-90)');
        expect(text).toContain('1 errored');
        expect(text).toContain('1x build failed');
        expect(text).toContain('run 2 (errored): setup failed');
    });
});
