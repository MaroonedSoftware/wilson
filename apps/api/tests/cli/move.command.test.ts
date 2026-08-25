import { describe, expect, it } from 'vitest';
import { buildCtx, connectionRefused, fetchMock, jsonResponse, methodOf, reasonResponse, urlOf, type Handler } from './sdk-fetch.helper.js';

// Card 0078 ports `move.command.ts` off `container.get(...)` and onto `@wilson/sdk`. Validating the
// target, recording the transition, and reclaiming a terminal card's worktree are
// `BoardWriteService.move`'s job now (card 0080) and are tested there
// (apps/api/tests/modules/board/board.write.service.test.ts) — this command reads the card first only
// to phrase the message (already-there vs moved vs flag-cleared), and the API is what actually
// decides and writes.
const { default: command } = await import('../../../../packages/cli/src/commands/card/move.command.js');

const run = (ctx: unknown, cardId: string, target: string) => (command.run as unknown as Handler)({}, ctx, [cardId, target]);

const card = (overrides: Partial<{ stage: string; needsHuman: boolean }> = {}) => ({
    id: '0001',
    title: 'x',
    stage: 'implementing',
    dependsOn: [],
    needsHuman: false,
    ...overrides,
});

describe('wilson card move', () => {
    it('reports a move to a different stage, calling POST .../move with the target', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(card({ stage: 'implementing' })));
        fetchMock.mockResolvedValueOnce(jsonResponse(card({ stage: 'testing' })));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0001', 'testing');

        expect(result).toBe(0);
        expect(urlOf(fetchMock.mock.calls[1]!)).toContain('/api/cards/0001/move');
        expect(methodOf(fetchMock.mock.calls[1]!)).toBe('POST');
        expect(JSON.parse((fetchMock.mock.calls[1]![1] as { body: string }).body)).toEqual({ stage: 'testing' });
        expect(logger.info).toHaveBeenCalledWith('0001: implementing → testing');
    });

    it('takes the no-op path — no move call, "already in" — when the card is already in the target and carries no flag', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(card({ stage: 'implementing', needsHuman: false })));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0001', 'implementing');

        expect(result).toBe(0);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(logger.info).toHaveBeenCalledWith('0001 is already in implementing');
    });

    it('still calls move — to clear the flag — when the target equals the current stage but the card is flagged', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(card({ stage: 'implementing', needsHuman: true })));
        fetchMock.mockResolvedValueOnce(jsonResponse(card({ stage: 'implementing', needsHuman: false })));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0001', 'implementing');

        expect(result).toBe(0);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(methodOf(fetchMock.mock.calls[1]!)).toBe('POST');
        expect(logger.info).toHaveBeenCalledWith('0001: cleared flag, stays in implementing');
    });

    it('prints the API-supplied reason and exits 1 for a target the stage graph refuses, rather than an HTTP status line', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(card({ stage: 'implementing' })));
        fetchMock.mockResolvedValueOnce(reasonResponse(400, '"not-a-stage" is not a valid target'));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0001', 'not-a-stage');

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith('"not-a-stage" is not a valid target');
    });

    it('names the refused connection instead of throwing when the API is not running', async () => {
        fetchMock.mockImplementationOnce(connectionRefused);
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0001', 'testing');

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('is it running?'));
    });
});
