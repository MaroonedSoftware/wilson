import { z } from 'zod';
import { ServerKitRouter, bodyParserMiddleware, requirePolicy } from '@maroonedsoftware/koa';
import { ApiKeysService } from '#modules/authentication/api.keys.service.js';
import { ApiKeySummary, CreateApiKeyRequest, IssuedApiKey } from '../generated/api.keys.js';
import { parseAndValidate } from '@maroonedsoftware/zod';

/**
 * generated from [api.keys.ck](../../data/contracts/api.keys.ck)
 */
export const ApiKeysRouter = ServerKitRouter();

/**
 * from [api.keys.ck](../../data/contracts/api.keys.ck) `GET /api/auth/keys`
 */
ApiKeysRouter.get('/api/auth/keys', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const service = ctx.container.get(ApiKeysService);
    const result: ApiKeySummary[] = await service.list();

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [api.keys.ck](../../data/contracts/api.keys.ck) `POST /api/auth/keys`
 */
ApiKeysRouter.post('/api/auth/keys', requirePolicy({ policy: 'wilson.step.up' }), bodyParserMiddleware(['json']), async ctx => {
    const body = await parseAndValidate(ctx.parsedBody, CreateApiKeyRequest);

    const service = ctx.container.get(ApiKeysService);
    const result: IssuedApiKey = await service.create(body);

    ctx.status = 201;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [api.keys.ck](../../data/contracts/api.keys.ck) `POST /api/auth/keys/{id}/rotate`
 */
ApiKeysRouter.post('/api/auth/keys/:id/rotate', requirePolicy({ policy: 'wilson.step.up' }), async ctx => {
    const { id } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
        }),
    );

    const service = ctx.container.get(ApiKeysService);
    const result: IssuedApiKey = await service.rotate(id);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [api.keys.ck](../../data/contracts/api.keys.ck) `DELETE /api/auth/keys/{id}`
 */
ApiKeysRouter.delete('/api/auth/keys/:id', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const { id } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
        }),
    );

    const service = ctx.container.get(ApiKeysService);
    const result: ApiKeySummary = await service.revoke(id);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});
