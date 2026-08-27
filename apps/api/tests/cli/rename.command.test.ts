import { describe, expect, it } from 'vitest';
import { buildCtx, connectionRefused, fetchMock, jsonResponse, methodOf, reasonResponse, urlOf, type Handler } from './sdk-fetch.helper.js';

// Card 0094 adds `wilson card rename <id> <title>`. Every refusal — unchanged title as a no-op, an
// empty or whitespace-only title, and a title whose current-title branch already carries commits —
// lives behind `POST /api/cards/:id/rename` (`BoardWriteService.rename`) and is tested there
// (apps/api/tests/modules/board/board.write.service.test.ts). This command reads the card first only
// to phrase the old-title/new-title message and to skip the round trip for the common no-op of
// re-running with the same title, the same idiom `move.command.test.ts` and `edit.command.test.ts`
// already use for their own commands.
const { default: command } = await import('../../../../packages/cli/src/commands/card/rename.command.js');

const run = (ctx: unknown, cardId: string, title: string) => (command.run as unknown as Handler)({}, ctx, [cardId, title]);

const card = (overrides: Partial<{ id: string; title: string }> = {}) => ({
    id: '0001',
    title: 'Old title',
    stage: 'implementing',
    dependsOn: [],
    needsHuman: false,
    ...overrides,
});

describe('wilson card rename', () => {
    it('reads the card, then POSTs .../rename with the new title and prints the old and new titles', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(card({ title: 'Old title' })));
        fetchMock.mockResolvedValueOnce(jsonResponse(card({ title: 'New title' })));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0001', 'New title');

        expect(result).toBe(0);
        expect(methodOf(fetchMock.mock.calls[0]!)).toBe('GET');
        expect(urlOf(fetchMock.mock.calls[1]!)).toContain('/api/cards/0001/rename');
        expect(methodOf(fetchMock.mock.calls[1]!)).toBe('POST');
        expect(JSON.parse((fetchMock.mock.calls[1]![1] as { body: string }).body)).toEqual({ title: 'New title' });
        expect(logger.info).toHaveBeenCalledWith('0001: "Old title" → "New title"');
    });

    it('takes the no-op path — no rename call — when the requested title equals the current one', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(card({ title: 'Same title' })));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0001', 'Same title');

        expect(result).toBe(0);
        // Only the read — the command itself skips the round trip rather than relying on the API's
        // own no-op to short-circuit it.
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(logger.info).toHaveBeenCalledWith('0001: title unchanged');
    });

    it("prints the API's refusal reason and exits 1 when the card's branch carries work the rename would strand", async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(card({ title: 'Old title' })));
        fetchMock.mockResolvedValueOnce(reasonResponse(400, 'cannot rename 0001: it has work on card/0001-old-title — renaming would strand it'));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0001', 'New title');

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith('cannot rename 0001: it has work on card/0001-old-title — renaming would strand it');
    });

    it('prints the API refusal reason and exits 1 for an empty title', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(card({ title: 'Old title' })));
        fetchMock.mockResolvedValueOnce(reasonResponse(400, 'cannot rename 0001: a title cannot be empty'));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0001', '');

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith('cannot rename 0001: a title cannot be empty');
    });

    it('names the refused connection instead of throwing when the API is not running', async () => {
        fetchMock.mockImplementationOnce(connectionRefused);
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0001', 'New title');

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('is it running?'));
    });
});
