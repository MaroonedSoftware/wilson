import { z } from 'zod';
import { ServerKitRouter, bodyParserMiddleware } from '@maroonedsoftware/koa';
import { ApiKeysService } from '#modules/authentication/api.keys.service.js';
import { ApiKeySummary, CreateApiKeyRequest, IssuedApiKey } from '../generated/api.keys.js';
import { parseAndValidate } from '@maroonedsoftware/zod';

/**
 * generated from [api.keys.ck](file://./../../data/contracts/api.keys.ck)
 */
export const ApiKeysRouter = ServerKitRouter();

/**
 * from [api.keys.ck](file://./../../data/contracts/api.keys.ck#L45)
 * anonymous access, no security required
 */
ApiKeysRouter.get('/api/auth/keys', async ctx => {
    const service = ctx.container.get(ApiKeysService);
    const result: ApiKeySummary[] = await service.list();

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [api.keys.ck](file://./../../data/contracts/api.keys.ck#L56)
 * anonymous access, no security required
 */
ApiKeysRouter.post('/api/auth/keys', bodyParserMiddleware(['json']), async ctx => {
    const body = await parseAndValidate(ctx.parsedBody, CreateApiKeyRequest);

    const service = ctx.container.get(ApiKeysService);
    const result: IssuedApiKey = await service.create(body);

    ctx.status = 201;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [api.keys.ck](file://./../../data/contracts/api.keys.ck#L79)
 * anonymous access, no security required
 */
ApiKeysRouter.post('/api/auth/keys/:id/rotate', async ctx => {
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
 * from [api.keys.ck](file://./../../data/contracts/api.keys.ck#L98)
 * anonymous access, no security required
 */
ApiKeysRouter.delete('/api/auth/keys/:id', async ctx => {
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
