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

describe('renderBatch', () => {
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
