import { describe, expect, it } from 'vitest';
import { buildCtx, connectionRefused, fetchMock, jsonResponse, methodOf, reasonResponse, urlOf, type Handler } from './sdk-fetch.helper.js';

// Card 0078 ports `versions.command.ts` off `container.get(...)` and onto `@wilson/sdk`. It used to
// read `BoardRepository.versions(cardId, limit)` and print `version.createdAt.toISO()` (a Luxon
// `DateTime`); the SDK's `CardVersion.createdAt` is already a wire ISO string, so the command now
// prints it directly rather than calling `.toISO()` on it.
const { default: command } = await import('../../../../packages/cli/src/commands/card/versions.command.js');

type VersionsOpts = { limit?: number };
const run = (ctx: unknown, cardId: string, opts: VersionsOpts = {}) => (command.run as unknown as Handler<VersionsOpts>)(opts, ctx, [cardId]);

describe('wilson card versions', () => {
    it('defaults to a limit of 20, passed through as a query parameter', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse([]));
        const { ctx } = buildCtx();

        await run(ctx, '0001');

        expect(urlOf(fetchMock.mock.calls[0]!)).toContain('/api/cards/0001/versions');
        expect(urlOf(fetchMock.mock.calls[0]!)).toContain('limit=20');
        expect(methodOf(fetchMock.mock.calls[0]!)).toBe('GET');
    });

    it('passes --limit through as the query parameter instead of the default', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse([]));
        const { ctx } = buildCtx();

        await run(ctx, '0001', { limit: 5 });

        expect(urlOf(fetchMock.mock.calls[0]!)).toContain('limit=5');
    });

    it('reports there are no versions rather than printing an empty table', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse([]));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0001');

        expect(result).toBe(0);
        expect(logger.info).toHaveBeenCalledWith('0001 has no versions');
    });

    it('prints each version with the wire ISO timestamp as-is, newest first', async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse([
                { id: 'v2', createdAt: '2026-02-01T00:00:00.000Z', message: 'Edit 0001 plan body' },
                { id: 'v1', createdAt: '2026-01-01T00:00:00.000Z', message: 'Create 0001: do the thing' },
            ]),
        );
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0001');

        expect(result).toBe(0);
        expect(logger.info).toHaveBeenCalledWith('v2  2026-02-01T00:00:00.000Z  Edit 0001 plan body');
        expect(logger.info).toHaveBeenCalledWith('v1  2026-01-01T00:00:00.000Z  Create 0001: do the thing');
    });

    it('prints the API-supplied reason and exits 1 for a card that does not exist, rather than an HTTP status line', async () => {
        fetchMock.mockResolvedValueOnce(reasonResponse(404, 'card 9999 not found'));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '9999');

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith('card 9999 not found');
    });

    it('names the refused connection instead of throwing when the API is not running', async () => {
        fetchMock.mockImplementationOnce(connectionRefused);
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0001');

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('is it running?'));
    });
});
