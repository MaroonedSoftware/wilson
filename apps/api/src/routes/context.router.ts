import { z } from 'zod';
import { ServerKitRouter, bodyParserMiddleware } from '@maroonedsoftware/koa';
import { ContextService } from '#modules/context/context.service.js';
import { AttachContextRequest, ContextSnapshot } from '../generated/context.js';
import { parseAndValidate } from '@maroonedsoftware/zod';

/**
 * generated from [context.ck](../../data/contracts/context.ck)
 */
export const ContextRouter = ServerKitRouter();

/**
 * from [context.ck](../../data/contracts/context.ck) `POST /api/cards/{id}/context`
 * anonymous access, no security required
 */
ContextRouter.post('/api/cards/:id/context', bodyParserMiddleware(['json']), async ctx => {
    const { id } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
        }),
    );

    const body = await parseAndValidate(ctx.parsedBody, AttachContextRequest);

    const service = ctx.container.get(ContextService);
    const result: ContextSnapshot = await service.attach(id, body);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [context.ck](../../data/contracts/context.ck) `GET /api/cards/{id}/context`
 * anonymous access, no security required
 */
ContextRouter.get('/api/cards/:id/context', async ctx => {
    const { id } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
        }),
    );

    const service = ctx.container.get(ContextService);
    const result: ContextSnapshot[] = await service.list(id);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * `delete`, not `post .../remove`: contractkit emits a DELETE handler like any other method, so
 * there is no reason to reach for the `/resolve`-style action suffix `board.ck` uses only where the
 * verb genuinely isn't one of the four HTTP methods this repo's contracts use elsewhere. A snapshot
 * has no history worth keeping once removed (`CardContextRepository.remove`'s own doc comment), so
 * unlike `.../plan/comments/{commentId}/resolve` this is a real delete, not a state transition.
 * from [context.ck](../../data/contracts/context.ck) `DELETE /api/cards/{id}/context/{contextId}`
 * anonymous access, no security required
 */
ContextRouter.delete('/api/cards/:id/context/:contextId', async ctx => {
    const { id, contextId } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
            contextId: z.string(),
        }),
    );

    const service = ctx.container.get(ContextService);
    await service.remove(id, contextId);

    ctx.status = 204;
});
