import { z } from 'zod';
import { ServerKitRouter, bodyParserMiddleware, requirePolicy } from '@maroonedsoftware/koa';
import { AttachmentService } from '#modules/context/attachment.service.js';
import { ContextService } from '#modules/context/context.service.js';
import { AttachContextRequest, CardAttachment, ContextSnapshot } from '../generated/context.js';
import { parseAndValidate } from '@maroonedsoftware/zod';
import { MultipartBody } from '@maroonedsoftware/multipart';

/**
 * generated from [context.ck](../../data/contracts/context.ck)
 */
export const ContextRouter = ServerKitRouter();

/**
 * from [context.ck](../../data/contracts/context.ck) `POST /api/cards/{id}/context`
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
 * from [context.ck](../../data/contracts/context.ck) `GET /api/cards/{id}/context`
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
 * from [context.ck](../../data/contracts/context.ck) `DELETE /api/cards/{id}/context/{contextId}`
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

/**
 * from [context.ck](../../data/contracts/context.ck) `POST /api/cards/{id}/attachments`
 */
ContextRouter.post('/api/cards/:id/attachments', requirePolicy({ policy: 'wilson.manage' }), bodyParserMiddleware(['multipart']), async ctx => {
    const { id } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
        }),
    );

    const multipartBody = ctx.parsedBody as MultipartBody;

    const service = ctx.container.get(AttachmentService);
    const result: CardAttachment = await service.attach(id, multipartBody);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [context.ck](../../data/contracts/context.ck) `GET /api/cards/{id}/attachments`
 */
ContextRouter.get('/api/cards/:id/attachments', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const { id } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
        }),
    );

    const service = ctx.container.get(AttachmentService);
    const result: CardAttachment[] = await service.list(id);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * `attachmentId`, not a second `id`, for the reason `{contextId}` above has: a `params` block is keyed
 * by name. Nesting under the card lets one 404 cover a card that does not exist and an attachment id
 * that does not exist, belongs to another card, or is not an id at all.
 * from [context.ck](../../data/contracts/context.ck) `GET /api/cards/{id}/attachments/{attachmentId}`
 */
ContextRouter.get('/api/cards/:id/attachments/:attachmentId', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const { id, attachmentId } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
            attachmentId: z.string(),
        }),
    );

    const service = ctx.container.get(AttachmentService);
    const result: {
        contentType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
        body: Buffer;
        headers: { xContentTypeOptions: string; contentSecurityPolicy: string };
    } = await service.bytes(id, attachmentId);

    ctx.status = 200;
    ctx.set('x-content-type-options', String(result.headers['xContentTypeOptions']));
    ctx.set('content-security-policy', String(result.headers['contentSecurityPolicy']));
    ctx.type = result.contentType;
    ctx.body = result.body;
});

/**
 * `attachmentId`, not a second `id`, for the reason `{contextId}` above has: a `params` block is keyed
 * by name. Nesting under the card lets one 404 cover a card that does not exist and an attachment id
 * that does not exist, belongs to another card, or is not an id at all.
 * from [context.ck](../../data/contracts/context.ck) `DELETE /api/cards/{id}/attachments/{attachmentId}`
 */
ContextRouter.delete('/api/cards/:id/attachments/:attachmentId', requirePolicy({ policy: 'wilson.manage' }), async ctx => {
    const { id, attachmentId } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
            attachmentId: z.string(),
        }),
    );

    const service = ctx.container.get(AttachmentService);
    await service.remove(id, attachmentId);

    ctx.status = 204;
});
