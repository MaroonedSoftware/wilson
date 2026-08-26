import { describe, expect, it } from 'vitest';
import { buildCtx, connectionRefused, fetchMock, jsonResponse, methodOf, reasonResponse, urlOf, type Handler } from './sdk-fetch.helper.js';

// Card 0078 ports `release.command.ts` off `container.get(...)` and onto `@wilson/sdk`. The in-flight
// check, the running-daemon disambiguation, and the cancel-and-clear itself are
// `BoardWriteService.release`'s job now (card 0080) and are tested there
// (apps/api/tests/modules/board/board.write.service.test.ts) — this command just calls it and reports.
const { default: command } = await import('../../../../packages/cli/src/commands/card/release.command.js');

const run = (ctx: unknown, cardId: string) => (command.run as unknown as Handler)({}, ctx, [cardId]);

describe('wilson card release', () => {
    it('calls release and reports the job cancelled and the claim cleared', async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse({ id: '0003', title: 'x', stage: 'implementing', dependsOn: [], needsHuman: false, releasedAs: 'queued' }),
        );
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0003');

        expect(result).toBe(0);
        expect(urlOf(fetchMock.mock.calls[0]!)).toContain('/api/cards/0003/release');
        expect(methodOf(fetchMock.mock.calls[0]!)).toBe('POST');
        expect(logger.info).toHaveBeenCalledWith('0003: released — cancelled a queued job that had not started, claim cleared');
        expect(logger.info).toHaveBeenCalledWith('the card itself has not moved; decide where it goes next with `wilson card move`.');
    });

    // Card 0087: the two safe-to-cancel cases are different actions and get different lines — this
    // is the other one, distinct from the "queued" case above.
    it('reports an orphaned job differently from a queued one, when releasedAs is orphan', async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse({ id: '0004', title: 'x', stage: 'implementing', dependsOn: [], needsHuman: false, releasedAs: 'orphan' }),
        );
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0004');

        expect(result).toBe(0);
        expect(logger.info).toHaveBeenCalledWith('0004: released — cancelled an orphaned job left behind by an earlier process, claim cleared');
    });

    it('prints the API-supplied reason and exits 1 for a card holding no claim, rather than an HTTP status line', async () => {
        fetchMock.mockResolvedValueOnce(reasonResponse(400, '0002 holds no claim — nothing to release'));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0002');

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith('0002 holds no claim — nothing to release');
    });

    it('prints the API-supplied reason when the process running the queue may genuinely have the job in flight', async () => {
        fetchMock.mockResolvedValueOnce(reasonResponse(400, '0001: job job-42 is claimed and this process is running it right now — it may genuinely be in flight'));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0001');

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith('0001: job job-42 is claimed and this process is running it right now — it may genuinely be in flight');
    });

    it('names the refused connection instead of throwing when the API is not running', async () => {
        fetchMock.mockImplementationOnce(connectionRefused);
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0001');

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('is it running?'));
    });
});
