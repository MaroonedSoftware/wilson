import { describe, expect, it, vi } from 'vitest';
import { BoardRouter } from '#src/routes/board.router.js';
import { PlanService } from '#modules/plan/plan.service.js';

/**
 * Card 0133: `POST /api/cards/:id/plan/turn`, the ordinary JSON half of a card's planning
 * conversation. `board.router.ts` is generated from `board.ck` (`pnpm codegen`), so what is worth
 * pinning down here is not the generator's own logic — it is that the generated handler for *this*
 * operation is wired the way the contract says: the path id and the validated `{ text }` body reach
 * `PlanService.turn`, and its result comes back as the JSON response body. Routing existence itself
 * (path/method matching) is covered in `routes.setup.test.ts`, alongside every other board route.
 *
 * The handler is pulled directly off `BoardRouter`'s route table and invoked without going through
 * `bodyParserMiddleware` or Koa's own request machinery — the same "call the registered function
 * with a structural fake context" approach `card.feed.route.test.ts` documents for SSE handlers,
 * applied here to a plain JSON one. `ctx.parsedBody` stands in for what the body parser would have
 * produced from a real request.
 */
const planTurnHandler = (): ((ctx: unknown, next: () => Promise<void>) => Promise<void>) => {
    const layer = BoardRouter.stack.find(l => l.path === '/api/cards/:id/plan/turn' && l.methods.includes('POST'));
    if (!layer) throw new Error('POST /api/cards/:id/plan/turn is not registered on BoardRouter');
    const handler = layer.stack.at(-1);
    if (!handler) throw new Error('matched layer carries no handler');
    return handler as unknown as (ctx: unknown, next: () => Promise<void>) => Promise<void>;
};

const noop = async (): Promise<void> => {};

describe('BoardRouter POST /api/cards/:id/plan/turn', () => {
    it("calls PlanService.turn with the path id and the validated request body, and returns its result as the JSON response", async () => {
        const turn = vi.fn(async () => ({ seq: 3, role: 'assistant', content: 'the reply', createdAt: '2024-01-01T00:00:00.000Z' }));
        const container = { get: (token: unknown) => (token === PlanService ? { turn } : undefined) };
        const ctx = { params: { id: '0042' }, parsedBody: { text: 'hello there' }, container } as Record<string, unknown>;

        await planTurnHandler()(ctx, noop);

        expect(turn).toHaveBeenCalledWith('0042', { text: 'hello there' });
        expect(ctx.status).toBe(200);
        expect(ctx.type).toBe('application/json');
        expect(ctx.body).toEqual({ seq: 3, role: 'assistant', content: 'the reply', createdAt: '2024-01-01T00:00:00.000Z' });
    });

    it('rejects a request body missing "text" without ever calling PlanService.turn', async () => {
        const turn = vi.fn();
        const container = { get: () => ({ turn }) };
        const ctx = { params: { id: '0042' }, parsedBody: {}, container } as Record<string, unknown>;

        await expect(planTurnHandler()(ctx, noop)).rejects.toBeTruthy();
        expect(turn).not.toHaveBeenCalled();
    });

    it('rejects a request body carrying an extra field, the same strict-schema refusal every other board write applies', async () => {
        const turn = vi.fn();
        const container = { get: () => ({ turn }) };
        const ctx = { params: { id: '0042' }, parsedBody: { text: 'hi', extra: 'field' }, container } as Record<string, unknown>;

        await expect(planTurnHandler()(ctx, noop)).rejects.toBeTruthy();
        expect(turn).not.toHaveBeenCalled();
    });

    it('surfaces the exact error PlanService.turn throws, rather than swallowing or rewriting it', async () => {
        const refusal = Object.assign(new Error('refused'), { statusCode: 400 });
        const turn = vi.fn(async () => {
            throw refusal;
        });
        const container = { get: () => ({ turn }) };
        const ctx = { params: { id: '0099' }, parsedBody: { text: 'hi' }, container } as Record<string, unknown>;

        await expect(planTurnHandler()(ctx, noop)).rejects.toBe(refusal);
    });
});
