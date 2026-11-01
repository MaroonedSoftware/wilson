import { describe, expect, it } from 'vitest';
import { buildCtx, connectionRefused, fetchMock, jsonResponse, methodOf, reasonResponse, urlOf, type Handler } from './sdk-fetch.helper.js';

// Card 0078 ports `ack.command.ts` off `container.get(...)` and onto `@wilson/sdk` — the flag-clearing
// and retry-counter rules this suite used to exercise against a real Postgres-backed board now live
// (and are tested) server-side in `BoardWriteService.ack`
// (apps/api/tests/modules/board/board.write.service.test.ts). What is left here is the CLI's own
// remaining behaviour: it reads the card first only to phrase its message, calls `ack`, and reports —
// or, for a refused card or an unreachable API, reports the operator-facing failure `withApi` and
// `describeApiError` produce.
const { default: command } = await import('../../../../packages/cli/src/commands/card/ack.command.js');

const run = (ctx: unknown, cardId: string) => (command.run as unknown as Handler)({}, ctx, [cardId]);

describe('wilson card ack', () => {
    it('reads the card, then clears the flag, reporting the reason and the stage whose retry counter reset', async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse({
                id: '0002',
                title: 'x',
                stage: 'implementing',
                dependsOn: [],
                needsHuman: true,
                needsHumanReason: 'kicked back too many times',
            }),
        );
        fetchMock.mockResolvedValueOnce(jsonResponse({ id: '0002', title: 'x', stage: 'implementing', dependsOn: [], needsHuman: false }));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0002');

        expect(result).toBe(0);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(urlOf(fetchMock.mock.calls[0]!)).toContain('/api/cards/0002');
        expect(methodOf(fetchMock.mock.calls[0]!)).toBe('GET');
        expect(urlOf(fetchMock.mock.calls[1]!)).toContain('/api/cards/0002/ack');
        expect(methodOf(fetchMock.mock.calls[1]!)).toBe('POST');
        // The read happens before the write — the message below is built from what the card looked
        // like before `ack` clears it.
        expect(logger.info).toHaveBeenCalledWith('0002: cleared flag (kicked back too many times), implementing retry counter reset');
    });

    it('falls back to "no reason recorded" when the card carries no needsHumanReason', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ id: '0004', title: 'x', stage: 'review', dependsOn: [], needsHuman: true }));
        fetchMock.mockResolvedValueOnce(jsonResponse({ id: '0004', title: 'x', stage: 'review', dependsOn: [], needsHuman: false }));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0004');

        expect(result).toBe(0);
        expect(logger.info).toHaveBeenCalledWith('0004: cleared flag (no reason recorded), review retry counter reset');
    });

    it('prints the API-supplied reason and exits 1 when the card is not flagged, rather than an HTTP status line', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ id: '0001', title: 'x', stage: 'implementing', dependsOn: [], needsHuman: false }));
        fetchMock.mockResolvedValueOnce(reasonResponse(400, '0001 is not flagged for a human'));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0001');

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith('0001 is not flagged for a human');
    });

    it('names the refused connection instead of throwing when the API is not running', async () => {
        fetchMock.mockImplementationOnce(connectionRefused);
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0001');

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('is it running?'));
    });
});
