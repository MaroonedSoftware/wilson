import { describe, expect, it } from 'vitest';
import { buildCtx, connectionRefused, fetchMock, jsonResponse, methodOf, urlOf, type Handler } from './sdk-fetch.helper.js';

// `wilson stages versions` mirrors `wilson card versions` over `GET /api/stages/config/versions` —
// the history `git log config/stages.yaml` on the board repo used to be.
const { default: command } = await import('../../../../packages/cli/src/commands/stages/versions.command.js');

const run = (ctx: unknown, opts: { limit?: number } = {}) => (command.run as unknown as Handler<{ limit?: number }>)(opts, ctx, []);

describe('wilson stages versions', () => {
    it('lists versions newest first, one line each, passing the limit through', async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse([
                { id: '9', message: 'Raise the review step budget', createdAt: '2026-09-01T10:00:00.000Z' },
                { id: '8', message: 'Imported from stages.yaml', createdAt: '2026-08-31T09:00:00.000Z' },
            ]),
        );
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, { limit: 5 });

        expect(result).toBe(0);
        expect(urlOf(fetchMock.mock.calls[0]!)).toContain('/api/stages/config/versions');
        expect(urlOf(fetchMock.mock.calls[0]!)).toContain('limit=5');
        expect(methodOf(fetchMock.mock.calls[0]!)).toBe('GET');
        expect(logger.info).toHaveBeenNthCalledWith(1, '9  2026-09-01T10:00:00.000Z  Raise the review step budget');
        expect(logger.info).toHaveBeenNthCalledWith(2, '8  2026-08-31T09:00:00.000Z  Imported from stages.yaml');
    });

    it('says so when there are no versions', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse([]));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx);

        expect(result).toBe(0);
        expect(logger.info).toHaveBeenCalledWith('no stage config versions');
    });

    it('names the refused connection instead of throwing when the API is not running', async () => {
        fetchMock.mockImplementationOnce(connectionRefused);
        const { ctx, logger } = buildCtx();

        const result = await run(ctx);

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('is it running?'));
    });
});
