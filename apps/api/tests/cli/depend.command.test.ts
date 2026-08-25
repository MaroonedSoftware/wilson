import { describe, expect, it } from 'vitest';
import { buildCtx, connectionRefused, fetchMock, jsonResponse, methodOf, reasonResponse, urlOf, type Handler } from './sdk-fetch.helper.js';

// Card 0078 ports `depend.command.ts` off `container.get(...)` and onto `@wilson/sdk`. The
// self-dependency refusal and the write itself now happen behind `POST /api/cards/:id/depend`
// (`BoardWriteService.depend`, card 0080, tested there); this command reads the card first only to
// phrase the already-there/already-gone no-op message, then calls the endpoint.
const { default: command } = await import('../../../../packages/cli/src/commands/card/depend.command.js');

type DependOpts = { remove?: boolean };
const run = (ctx: unknown, cardId: string, dependsOnId: string, opts: DependOpts = {}) =>
    (command.run as unknown as Handler<DependOpts>)(opts, ctx, [cardId, dependsOnId]);

const card = (dependsOn: string[] = []) => ({ id: '0002', title: 'x', stage: 'implementing', dependsOn, needsHuman: false });

describe('wilson card depend', () => {
    it('reads the card, then records the dependency, calling POST .../depend with the target and no removal', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(card([])));
        fetchMock.mockResolvedValueOnce(jsonResponse(card(['0001'])));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0002', '0001');

        expect(result).toBe(0);
        expect(urlOf(fetchMock.mock.calls[0]!)).toContain('/api/cards/0002');
        expect(methodOf(fetchMock.mock.calls[0]!)).toBe('GET');
        expect(urlOf(fetchMock.mock.calls[1]!)).toContain('/api/cards/0002/depend');
        expect(methodOf(fetchMock.mock.calls[1]!)).toBe('POST');
        expect(JSON.parse((fetchMock.mock.calls[1]![1] as { body: string }).body)).toEqual({ dependsOnId: '0001', remove: undefined });
        expect(logger.info).toHaveBeenCalledWith('0002 depends on 0001');
    });

    it('takes the no-op path — no write call — when the card already depends on the target', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(card(['0001'])));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0002', '0001');

        expect(result).toBe(0);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(logger.info).toHaveBeenCalledWith('0002 already depends on 0001');
    });

    it('drops an existing dependency with --remove, calling POST .../depend with remove: true', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(card(['0001'])));
        fetchMock.mockResolvedValueOnce(jsonResponse(card([])));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0002', '0001', { remove: true });

        expect(result).toBe(0);
        expect(JSON.parse((fetchMock.mock.calls[1]![1] as { body: string }).body)).toEqual({ dependsOnId: '0001', remove: true });
        expect(logger.info).toHaveBeenCalledWith('0002 no longer depends on 0001');
    });

    it('takes the no-op path — no write call — with --remove when the card does not depend on the target', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(card([])));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0002', '0001', { remove: true });

        expect(result).toBe(0);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(logger.info).toHaveBeenCalledWith('0002 does not depend on 0001');
    });

    it('prints the API-supplied reason and exits 1 for a self-dependency, rather than an HTTP status line', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(card([])));
        fetchMock.mockResolvedValueOnce(reasonResponse(400, 'a card cannot depend on itself'));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0002', '0002');

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith('a card cannot depend on itself');
    });

    it('names the refused connection instead of throwing when the API is not running', async () => {
        fetchMock.mockImplementationOnce(connectionRefused);
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0002', '0001');

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('is it running?'));
    });
});
