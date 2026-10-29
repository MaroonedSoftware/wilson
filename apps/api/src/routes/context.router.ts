import { z } from 'zod';
import { ServerKitRouter, bodyParserMiddleware, requirePolicy } from '@maroonedsoftware/koa';
import { ContextService } from '#modules/context/context.service.js';
import { AttachContextRequest, ContextSnapshot } from '../generated/context.js';
import { parseAndValidate } from '@maroonedsoftware/zod';

/**
 * generated from [context.ck](file://./../../data/contracts/context.ck)
 */
export const ContextRouter = ServerKitRouter();

/**
 * from [context.ck](file://./../../data/contracts/context.ck#L43)
 */
ContextRouter.post('/api/cards/:id/context', requirePolicy({ policy: 'wilson.manage' }), bodyParserMiddleware(['json']), async ctx => {
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
 * from [context.ck](file://./../../data/contracts/context.ck#L61)
 */
ContextRouter.get('/api/cards/:id/context', requirePolicy({ policy: 'wilson.view' }), async ctx => {
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
 * from [context.ck](file://./../../data/contracts/context.ck#L86)
 */
ContextRouter.delete('/api/cards/:id/context/:contextId', requirePolicy({ policy: 'wilson.manage' }), async ctx => {
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
