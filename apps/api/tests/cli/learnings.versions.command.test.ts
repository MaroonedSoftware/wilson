import { describe, expect, it } from 'vitest';
import { buildCtx, connectionRefused, fetchMock, jsonResponse, methodOf, urlOf, type Handler } from './sdk-fetch.helper.js';

// `wilson learnings versions` mirrors `wilson stages versions` over `GET /api/learnings/versions`
// (AC2) — the history a `git log` on a committed learnings file would have answered.
const { default: command } = await import('../../../../packages/cli/src/commands/learnings/versions.command.js');

const run = (ctx: unknown, opts: { limit?: number } = {}) => (command.run as unknown as Handler<{ limit?: number }>)(opts, ctx, []);

describe('wilson learnings versions', () => {
    it('lists versions newest first, one line each, passing the limit through', async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse([
                { id: '9', message: 'Never retry without backoff', createdAt: '2026-09-01T10:00:00.000Z' },
                { id: '8', message: 'Imported from the old wiki', createdAt: '2026-08-31T09:00:00.000Z' },
            ]),
        );
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, { limit: 5 });

        expect(result).toBe(0);
        expect(urlOf(fetchMock.mock.calls[0]!)).toContain('/api/learnings/versions');
        expect(urlOf(fetchMock.mock.calls[0]!)).toContain('limit=5');
        expect(methodOf(fetchMock.mock.calls[0]!)).toBe('GET');
        expect(logger.info).toHaveBeenNthCalledWith(1, '9  2026-09-01T10:00:00.000Z  Never retry without backoff');
        expect(logger.info).toHaveBeenNthCalledWith(2, '8  2026-08-31T09:00:00.000Z  Imported from the old wiki');
    });

    it('says so when there are no versions', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse([]));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx);

        expect(result).toBe(0);
        expect(logger.info).toHaveBeenCalledWith('no learnings versions');
    });

    it('names the refused connection instead of throwing when the API is not running', async () => {
        fetchMock.mockImplementationOnce(connectionRefused);
        const { ctx, logger } = buildCtx();

        const result = await run(ctx);

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('is it running?'));
    });
});
