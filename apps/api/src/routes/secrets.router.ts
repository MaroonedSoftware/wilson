import { z } from 'zod';
import { ServerKitRouter, bodyParserMiddleware, requirePolicy } from '@maroonedsoftware/koa';
import { SecretsService } from '#modules/secrets/secrets.service.js';
import { PutSecretRequest, SecretSummary } from '../generated/secrets.js';
import { parseAndValidate } from '@maroonedsoftware/zod';

/**
 * generated from [secrets.ck](../../data/contracts/secrets.ck)
 */
export const SecretsRouter = ServerKitRouter();

/**
 * from [secrets.ck](../../data/contracts/secrets.ck) `GET /api/secrets`
 */
SecretsRouter.get('/api/secrets', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const service = ctx.container.get(SecretsService);
    const result: SecretSummary[] = await service.list();

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * Save a value under `name`, replacing any saved there, so rotating is putting again.
 * from [secrets.ck](../../data/contracts/secrets.ck) `PUT /api/secrets/{name}`
 */
SecretsRouter.put('/api/secrets/:name', requirePolicy({ policy: 'wilson.step.up' }), bodyParserMiddleware(['json']), async ctx => {
    const { name } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            name: z.string(),
        }),
    );

    const body = await parseAndValidate(ctx.parsedBody, PutSecretRequest);

    const service = ctx.container.get(SecretsService);
    const result: SecretSummary = await service.put(name, body);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * Forget a secret. This does not revoke it with whoever issued it.
 * from [secrets.ck](../../data/contracts/secrets.ck) `DELETE /api/secrets/{name}`
 */
SecretsRouter.delete('/api/secrets/:name', requirePolicy({ policy: 'wilson.step.up' }), async ctx => {
    const { name } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            name: z.string(),
        }),
    );

    const service = ctx.container.get(SecretsService);
    await service.remove(name);

    ctx.status = 204;
});
