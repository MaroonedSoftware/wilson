import { describe, expect, it } from 'vitest';
import { buildCtx, connectionRefused, fetchMock, jsonResponse, methodOf, reasonResponse, urlOf, type Handler } from './sdk-fetch.helper.js';

// Card 0078 ports `board import` off `container.get(...)` and onto `@wilson/sdk`. Reading the legacy
// board and refusing an empty or already-imported one used to happen in-process
// (`BoardImporter.readLegacyBoard`/`.import`); both now happen behind `POST /api/board/import`
// (`BoardBootstrapService.import`, card 0076, tested there) against whatever board repo the API is
// configured with — this command just calls it, with `--dry-run` forwarded, and reports.
const { default: command } = await import('../../../../packages/cli/src/commands/board/import.command.js');

type ImportOpts = { dryRun?: boolean };
const run = (ctx: unknown, opts: ImportOpts = {}) => (command.run as unknown as Handler<ImportOpts>)(opts, ctx, []);

describe('wilson board import', () => {
    it('imports and reports the counts, naming the configured project', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ cards: 12, dependencies: 4, unpinned: [], skipped: false }));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx);

        expect(result).toBe(0);
        expect(urlOf(fetchMock.mock.calls[0]!)).toContain('/api/board/import');
        expect(methodOf(fetchMock.mock.calls[0]!)).toBe('POST');
        expect(JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body)).toEqual({ dryRun: false });
        expect(logger.info).toHaveBeenCalledWith('imported 12 cards and 4 dependencies into project "wilson"');
    });

    it('forwards --dry-run, and reports a would-import without writing', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ cards: 12, dependencies: 4, unpinned: [], skipped: true }));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, { dryRun: true });

        expect(result).toBe(0);
        expect(JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body)).toEqual({ dryRun: true });
        expect(logger.info).toHaveBeenCalledWith('would import 12 cards and 4 dependencies into project "wilson"');
        expect(logger.info).toHaveBeenCalledWith('dry run — nothing written');
    });

    it('warns, per card, about a plan pinned to a board-repo commit that could not be recovered', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ cards: 1, dependencies: 0, unpinned: ['0007'], skipped: false }));
        const { ctx, logger } = buildCtx();

        await run(ctx);

        expect(logger.warn).toHaveBeenCalledWith(
            '0007 was pinned to a board-repo commit; its plan text at that commit is not recoverable, so it is now pinned to the imported version',
        );
    });

    it('prints the API-supplied reason and exits 1 for a board that already has cards, rather than an HTTP status line', async () => {
        fetchMock.mockResolvedValueOnce(reasonResponse(409, 'project "wilson" already has cards — import refused'));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx);

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith('project "wilson" already has cards — import refused');
    });

    it('names the refused connection instead of throwing when the API is not running', async () => {
        fetchMock.mockImplementationOnce(connectionRefused);
        const { ctx, logger } = buildCtx();

        const result = await run(ctx);

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('is it running?'));
    });
});
