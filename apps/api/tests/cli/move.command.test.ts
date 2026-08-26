import { describe, expect, it } from 'vitest';
import { buildCtx, connectionRefused, fetchMock, jsonResponse, methodOf, reasonResponse, urlOf, type Handler } from './sdk-fetch.helper.js';

// Card 0078 ports `move.command.ts` off `container.get(...)` and onto `@wilson/sdk`. Validating the
// target, recording the transition, and reclaiming a terminal card's worktree are
// `BoardWriteService.move`'s job now (card 0080) and are tested there
// (apps/api/tests/modules/board/board.write.service.test.ts) — this command reads the card first only
// to phrase the message (already-there vs moved vs flag-cleared), and the API is what actually
// decides and writes.
//
// Card 0090 adds a warning — never a refusal — when the target is a dead stage (`dropped`,
// `poisoned`) and something depends on this card: without it, dropping/poisoning a card silently and
// permanently blocks every dependent (see board-view.test.ts for deadStages/deadDependencies
// directly). That path costs two extra calls (`GET /api/stages`, then `GET /api/cards`) before the
// move itself, so every pre-existing test below now mocks a `columns()` response for the stage check.
const { default: command } = await import('../../../../packages/cli/src/commands/card/move.command.js');

const run = (ctx: unknown, cardId: string, target: string) => (command.run as unknown as Handler)({}, ctx, [cardId, target]);

const card = (overrides: Partial<{ id: string; stage: string; needsHuman: boolean; dependsOn: string[] }> = {}) => ({
    id: '0001',
    title: 'x',
    stage: 'implementing',
    dependsOn: [],
    needsHuman: false,
    ...overrides,
});

// A fresh `Response` per call — its body can only be read once, and each test's `fetchMock` queue
// needs its own. Only 'testing' is a real stage here; the rest mirror the board's actual
// NON_STAGE_STATES so `deadStages` behaves the way it does in production.
const columns = () => jsonResponse({ stages: ['implementing', 'testing'], nonStages: ['parking-lot', 'merged', 'poisoned', 'dropped'] });

describe('wilson card move', () => {
    it('reports a move to a different stage, calling POST .../move with the target', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(card({ stage: 'implementing' })));
        fetchMock.mockResolvedValueOnce(columns());
        fetchMock.mockResolvedValueOnce(jsonResponse(card({ stage: 'testing' })));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0001', 'testing');

        expect(result).toBe(0);
        expect(urlOf(fetchMock.mock.calls[2]!)).toContain('/api/cards/0001/move');
        expect(methodOf(fetchMock.mock.calls[2]!)).toBe('POST');
        expect(JSON.parse((fetchMock.mock.calls[2]![1] as { body: string }).body)).toEqual({ stage: 'testing' });
        expect(logger.info).toHaveBeenCalledWith('0001: implementing → testing');
    });

    it('takes the no-op path — no move call, "already in" — when the card is already in the target and carries no flag', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(card({ stage: 'implementing', needsHuman: false })));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0001', 'implementing');

        expect(result).toBe(0);
        // Same-stage-no-flag returns before the dead-stage check even runs — one call total.
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(logger.info).toHaveBeenCalledWith('0001 is already in implementing');
    });

    it('still calls move — to clear the flag — when the target equals the current stage but the card is flagged', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(card({ stage: 'implementing', needsHuman: true })));
        fetchMock.mockResolvedValueOnce(columns());
        fetchMock.mockResolvedValueOnce(jsonResponse(card({ stage: 'implementing', needsHuman: false })));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0001', 'implementing');

        expect(result).toBe(0);
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(methodOf(fetchMock.mock.calls[2]!)).toBe('POST');
        expect(logger.info).toHaveBeenCalledWith('0001: cleared flag, stays in implementing');
    });

    it('prints the API-supplied reason and exits 1 for a target the stage graph refuses, rather than an HTTP status line', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(card({ stage: 'implementing' })));
        fetchMock.mockResolvedValueOnce(columns());
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

    it('warns, naming each dependent and its --remove incantation, when dropping a card something depends on — and still performs the move', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(card({ id: '0085', stage: 'implementing' })));
        fetchMock.mockResolvedValueOnce(columns());
        fetchMock.mockResolvedValueOnce(
            jsonResponse([
                card({ id: '0079', dependsOn: ['0078', '0085'] }),
                card({ id: '0090', dependsOn: ['0085'] }),
                card({ id: '0091', dependsOn: ['0078'] }),
            ]),
        );
        fetchMock.mockResolvedValueOnce(jsonResponse(card({ id: '0085', stage: 'dropped' })));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0085', 'dropped');

        expect(result).toBe(0);
        expect(logger.info).toHaveBeenCalledWith(
            'warning: 0085 will never reach merged from dropped — this permanently blocks 0079, 0090, which depend on it. ' +
                'Clear each link, or leave it blocked on purpose:',
        );
        expect(logger.info).toHaveBeenCalledWith('  wilson card depend 0079 0085 --remove');
        expect(logger.info).toHaveBeenCalledWith('  wilson card depend 0090 0085 --remove');
        expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('0091'));
        // The move still happens — this is a warning, not a refusal.
        expect(urlOf(fetchMock.mock.calls[3]!)).toContain('/api/cards/0085/move');
        expect(logger.info).toHaveBeenCalledWith('0085: implementing → dropped');
    });

    it('warns the same way for poisoning a depended-on card', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(card({ id: '0085', stage: 'implementing' })));
        fetchMock.mockResolvedValueOnce(columns());
        fetchMock.mockResolvedValueOnce(jsonResponse([card({ id: '0079', dependsOn: ['0085'] })]));
        fetchMock.mockResolvedValueOnce(jsonResponse(card({ id: '0085', stage: 'poisoned' })));
        const { ctx, logger } = buildCtx();

        await run(ctx, '0085', 'poisoned');

        expect(logger.info).toHaveBeenCalledWith(
            'warning: 0085 will never reach merged from poisoned — this permanently blocks 0079, which depend on it. ' +
                'Clear each link, or leave it blocked on purpose:',
        );
    });

    it('prints no extra noise dropping a card nothing depends on', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(card({ id: '0085', stage: 'implementing' })));
        fetchMock.mockResolvedValueOnce(columns());
        fetchMock.mockResolvedValueOnce(jsonResponse([card({ id: '0001', dependsOn: [] })]));
        fetchMock.mockResolvedValueOnce(jsonResponse(card({ id: '0085', stage: 'dropped' })));
        const { ctx, logger } = buildCtx();

        await run(ctx, '0085', 'dropped');

        expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('warning'));
        expect(logger.info).toHaveBeenCalledWith('0085: implementing → dropped');
    });

    it('does not fetch the card list, or warn, when the target is an ordinary — not dead — stage', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(card({ id: '0085', stage: 'implementing' })));
        fetchMock.mockResolvedValueOnce(columns());
        fetchMock.mockResolvedValueOnce(jsonResponse(card({ id: '0085', stage: 'testing' })));
        const { ctx, logger } = buildCtx();

        await run(ctx, '0085', 'testing');

        // Only three calls: the card, the stage columns, and the move itself — no dependents fetch.
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('warning'));
    });
});
