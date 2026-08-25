import { describe, expect, it } from 'vitest';
import { buildCtx, connectionRefused, fetchMock, jsonResponse, methodOf, reasonResponse, urlOf, type Handler } from './sdk-fetch.helper.js';

// Card 0078 ports `start.command.ts` off `container.get(...)` and onto `@wilson/sdk`. The
// dispatchability check, the in-flight-claim check, and the enqueue itself are
// `BoardWriteService.start`'s job now (card 0080) and are tested there
// (apps/api/tests/modules/board/board.write.service.test.ts) — this command just calls it and reports.
//
// Caveat, reported per this card's task 4: the old CLI-side `start.command.ts` also warned when the
// card being started shared "Files in scope" globs with a card currently in flight (`scopeOverlap`,
// card 0069/0072). `BoardWriteService.start` does not reproduce that warning, and the wire contract
// (`CardDetail`/`CardSummary`) exposes neither a card's in-flight job claim nor any other card's
// scope, so this command has no data left to recompute it from either. That warning is gone, not
// merely relocated — a real behaviour loss this card cannot fix without either a new endpoint or
// scope beyond `packages/cli/**`/`apps/api/tests/cli/**`. Whoever owns `BoardWriteService.start` next
// should decide whether to restore it there.
const { default: command } = await import('../../../../packages/cli/src/commands/card/start.command.js');

const run = (ctx: unknown, cardId: string) => (command.run as unknown as Handler)({}, ctx, [cardId]);

describe('wilson card start', () => {
    it('calls start and reports the card enqueued at its stage', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ id: '0066', title: 'x', stage: 'implementing', dependsOn: [], needsHuman: false }));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0066');

        expect(result).toBe(0);
        expect(urlOf(fetchMock.mock.calls[0]!)).toContain('/api/cards/0066/start');
        expect(methodOf(fetchMock.mock.calls[0]!)).toBe('POST');
        expect(logger.info).toHaveBeenCalledWith('enqueued 0066 · implementing');
        expect(logger.info).toHaveBeenCalledWith(
            'the job runs wherever the API is draining the queue — start it with `pnpm --filter @wilson/api start` if nothing is.',
        );
    });

    it('prints the API-supplied reason and exits 1 for a card whyNotDispatchable refuses, rather than an HTTP status line', async () => {
        fetchMock.mockResolvedValueOnce(reasonResponse(400, 'cannot enqueue 0002: 0002 is in stage "needs-human"'));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0002');

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith('cannot enqueue 0002: 0002 is in stage "needs-human"');
    });

    it('prints the API-supplied reason for a card something is already carrying', async () => {
        fetchMock.mockResolvedValueOnce(reasonResponse(400, 'cannot enqueue 0066: job job-1 is already carrying it'));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0066');

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith('cannot enqueue 0066: job job-1 is already carrying it');
    });

    it('names the refused connection instead of throwing when the API is not running', async () => {
        fetchMock.mockImplementationOnce(connectionRefused);
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0066');

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('is it running?'));
    });
});
