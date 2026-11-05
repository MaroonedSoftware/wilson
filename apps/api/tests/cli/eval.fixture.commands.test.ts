import { describe, expect, it } from 'vitest';
import { buildCtx, fetchMock, jsonResponse, methodOf, reasonResponse, urlOf, type Handler } from './sdk-fetch.helper.js';

const { default: add } = await import('../../../../packages/cli/src/commands/eval/fixture-add.command.js');
const { default: remove } = await import('../../../../packages/cli/src/commands/eval/fixture-remove.command.js');

const fixture = {
    id: '7',
    sourceCardId: '0123',
    title: 'x',
    stage: 'review',
    planVersionId: '9',
    baseSha: 'b'.repeat(40),
    headSha: 'c'.repeat(40),
    warnings: ['a warning'],
    createdAt: '2026-11-05T00:00:00.000Z',
};

describe('wilson eval fixture', () => {
    it('add captures the attempt and passes warnings on', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(fixture, 201));
        const { ctx, logger } = buildCtx();

        const result = await (add.run as unknown as Handler)({ attempt: 2 }, ctx, ['0123', 'review']);

        expect(result).toBe(0);
        expect(urlOf(fetchMock.mock.calls[0]!)).toContain('/api/evals/fixtures');
        expect(methodOf(fetchMock.mock.calls[0]!)).toBe('POST');
        expect(logger.warn).toHaveBeenCalledWith('a warning');
    });

    it('add prints the API’s reason for a refusal', async () => {
        fetchMock.mockResolvedValueOnce(reasonResponse(404, 'card 0123 has no record of an attempt at review'));
        const { ctx, logger } = buildCtx();

        const result = await (add.run as unknown as Handler)({}, ctx, ['0123', 'review']);

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith('card 0123 has no record of an attempt at review');
    });

    it('rm deletes the fixture', async () => {
        fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
        const { ctx } = buildCtx();

        const result = await (remove.run as unknown as Handler)({}, ctx, ['7']);

        expect(result).toBe(0);
        expect(urlOf(fetchMock.mock.calls[0]!)).toContain('/api/evals/fixtures/7');
        expect(methodOf(fetchMock.mock.calls[0]!)).toBe('DELETE');
    });
});
