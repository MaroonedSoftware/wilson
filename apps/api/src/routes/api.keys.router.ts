import { z } from 'zod';
import { ServerKitRouter, bodyParserMiddleware, requirePolicy } from '@maroonedsoftware/koa';
import { ApiKeysService } from '#modules/authentication/api.keys.service.js';
import { ApiKeySummary, CreateApiKeyRequest, IssuedApiKey } from '../generated/api.keys.js';
import { parseAndValidate } from '@maroonedsoftware/zod';

/**
 * generated from [api.keys.ck](file://./../../data/contracts/api.keys.ck)
 */
export const ApiKeysRouter = ServerKitRouter();

/**
 * from [api.keys.ck](file://./../../data/contracts/api.keys.ck#L48)
 */
ApiKeysRouter.get('/api/auth/keys', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const service = ctx.container.get(ApiKeysService);
    const result: ApiKeySummary[] = await service.list();

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [api.keys.ck](file://./../../data/contracts/api.keys.ck#L62)
 */
ApiKeysRouter.post('/api/auth/keys', requirePolicy({ policy: 'wilson.manage' }), bodyParserMiddleware(['json']), async ctx => {
    const body = await parseAndValidate(ctx.parsedBody, CreateApiKeyRequest);

    const service = ctx.container.get(ApiKeysService);
    const result: IssuedApiKey = await service.create(body);

    ctx.status = 201;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [api.keys.ck](file://./../../data/contracts/api.keys.ck#L85)
 */
ApiKeysRouter.post('/api/auth/keys/:id/rotate', requirePolicy({ policy: 'wilson.manage' }), async ctx => {
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
 * from [api.keys.ck](file://./../../data/contracts/api.keys.ck#L104)
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
