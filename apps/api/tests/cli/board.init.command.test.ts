import { describe, expect, it } from 'vitest';
import { buildCtx, connectionRefused, fetchMock, jsonResponse, methodOf, reasonResponse, urlOf, type Handler } from './sdk-fetch.helper.js';

// Card 0078 ports `board init` off `container.get(...)` and onto `@wilson/sdk`. Giving the project
// its first stage config — a stored document `parseStages` accepts unedited — is
// `BoardBootstrapService.init`'s job now (card 0076) and is tested there
// (apps/api/tests/modules/board/board.bootstrap.service.test.ts) — this command just calls it and
// reports the configured stages.
const { default: command } = await import('../../../../packages/cli/src/commands/board/init.command.js');

const run = (ctx: unknown) => (command.run as unknown as Handler)({}, ctx, []);

describe('wilson board init', () => {
    it('calls board init and reports the configured stages', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ stages: ['planning', 'implementing', 'testing'], nonStages: ['parking-lot', 'merged'] }));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx);

        expect(result).toBe(0);
        expect(urlOf(fetchMock.mock.calls[0]!)).toContain('/api/board/init');
        expect(methodOf(fetchMock.mock.calls[0]!)).toBe('POST');
        expect(logger.info).toHaveBeenCalledWith('board initialised — stages: planning, implementing, testing');
        expect(logger.info).toHaveBeenCalledWith('Write a card with `wilson card create <title>`, approve its plan, then `wilson card start <id>`.');
    });

    it('prints the API-supplied reason and exits 1 for a board that is already initialised, rather than an HTTP status line', async () => {
        fetchMock.mockResolvedValueOnce(reasonResponse(409, 'project "wilson" already has a stage config'));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx);

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith('project "wilson" already has a stage config');
    });

    it('names the refused connection instead of throwing when the API is not running', async () => {
        fetchMock.mockImplementationOnce(connectionRefused);
        const { ctx, logger } = buildCtx();

        const result = await run(ctx);

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('is it running?'));
    });
});
