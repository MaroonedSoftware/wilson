import { describe, expect, it, vi } from 'vitest';
import { buildCtx, fetchMock, jsonResponse, methodOf, urlOf, type Handler } from './sdk-fetch.helper.js';

const editBody = vi.fn<(initial: string, name: string) => Promise<string | undefined>>();
vi.mock('../../../../packages/cli/src/commands/card/editor.js', () => ({ editBody }));

const { default: command } = await import('../../../../packages/cli/src/commands/card/answer.command.js');

const run = (ctx: unknown, ...args: string[]) => (command.run as unknown as Handler)({}, ctx, args);

const card = {
    id: '0002',
    title: 'x',
    stage: 'implementing',
    dependsOn: [],
    needsHuman: true,
    needsHumanReason: 'Keep the old endpoint?',
    blocked: {
        category: 'decision',
        tried: 'read it',
        question: 'Keep the old endpoint?',
        stage: 'implementing',
        askedAt: '2026-11-04T09:00:00.000Z',
    },
};

describe('wilson card answer', () => {
    it('posts the answer from the command line', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(card));
        fetchMock.mockResolvedValueOnce(jsonResponse({ ...card, needsHuman: false, needsHumanReason: undefined, blocked: undefined }));
        const { ctx, logger } = buildCtx();

        expect(await run(ctx, '0002', 'Keep it.')).toBe(0);

        const [call] = fetchMock.mock.calls.slice(1);
        expect(urlOf(call!)).toContain('/api/cards/0002/answer');
        expect(methodOf(call!)).toBe('POST');
        expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({ answer: 'Keep it.' });
        expect(logger.info).toHaveBeenCalledWith('implementing asks: Keep the old endpoint?');
        expect(editBody).not.toHaveBeenCalled();
    });

    it('opens the editor with no answer on the command line, and writes nothing if it closes empty', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(card));
        editBody.mockResolvedValueOnce(undefined);
        const { ctx } = buildCtx();

        expect(await run(ctx, '0002')).toBe(1);

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('refuses a card with no question before asking for anything', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ ...card, blocked: undefined }));
        const { ctx, logger } = buildCtx();

        expect(await run(ctx, '0002', 'Keep it.')).toBe(1);

        expect(logger.error).toHaveBeenCalledWith('0002 has no question waiting for an answer');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
