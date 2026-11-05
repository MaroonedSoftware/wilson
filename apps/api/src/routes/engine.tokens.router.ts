import { z } from 'zod';
import { ServerKitRouter, bodyParserMiddleware, requirePolicy } from '@maroonedsoftware/koa';
import { EngineTokensService } from '#modules/host/engine.tokens.service.js';
import { EngineUsageService } from '#modules/host/engine.usage.service.js';
import {
    EngineAccountUsage,
    EngineAccountUsageQuery,
    EngineLimit,
    EngineTokenSummary,
    PutEngineTokenRequest,
    UpdateEngineTokenRequest,
} from '../generated/engine.tokens.js';
import { parseAndValidate } from '@maroonedsoftware/zod';

/**
 * generated from [engine.tokens.ck](../../data/contracts/engine.tokens.ck)
 */
export const EngineTokensRouter = ServerKitRouter();

/**
 * from [engine.tokens.ck](../../data/contracts/engine.tokens.ck) `GET /api/engine-limits`
 */
EngineTokensRouter.get('/api/engine-limits', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const service = ctx.container.get(EngineTokensService);
    const result: EngineLimit[] = await service.limitsInForce();

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [engine.tokens.ck](../../data/contracts/engine.tokens.ck) `GET /api/engine-tokens`
 */
EngineTokensRouter.get('/api/engine-tokens', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const service = ctx.container.get(EngineTokensService);
    const result: EngineTokenSummary[] = await service.list();

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * Save a token under `name`, replacing any saved there, so rotating is putting again. A new value
 * reaches the next engine started with it, never one already running.
 * from [engine.tokens.ck](../../data/contracts/engine.tokens.ck) `PUT /api/engine-tokens/{name}`
 */
EngineTokensRouter.put('/api/engine-tokens/:name', requirePolicy({ policy: 'wilson.manage' }), bodyParserMiddleware(['json']), async ctx => {
    const { name } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            name: z.string(),
        }),
    );

    const body = await parseAndValidate(ctx.parsedBody, PutEngineTokenRequest);

    const service = ctx.container.get(EngineTokensService);
    const result: EngineTokenSummary = await service.put(name, body);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * Change what is recorded about a saved token, keeping the token and what it has hit.
 * from [engine.tokens.ck](../../data/contracts/engine.tokens.ck) `PATCH /api/engine-tokens/{name}`
 */
EngineTokensRouter.patch('/api/engine-tokens/:name', requirePolicy({ policy: 'wilson.manage' }), bodyParserMiddleware(['json']), async ctx => {
    const { name } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            name: z.string(),
        }),
    );

    const body = await parseAndValidate(ctx.parsedBody, UpdateEngineTokenRequest);

    const service = ctx.container.get(EngineTokensService);
    const result: EngineTokenSummary = await service.update(name, body);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * Forget a token. This does not revoke it with Anthropic, and an engine already running keeps it.
 * Hosts assigned it go back to the worker's own sign-in.
 * from [engine.tokens.ck](../../data/contracts/engine.tokens.ck) `DELETE /api/engine-tokens/{name}`
 */
EngineTokensRouter.delete('/api/engine-tokens/:name', requirePolicy({ policy: 'wilson.manage' }), async ctx => {
    const { name } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            name: z.string(),
        }),
    );

    const service = ctx.container.get(EngineTokensService);
    await service.remove(name);

    ctx.status = 204;
});

/**
 * Each account that spent anything in the window, most output first.
 * from [engine.tokens.ck](../../data/contracts/engine.tokens.ck) `GET /api/engine-accounts/usage`
 */
EngineTokensRouter.get('/api/engine-accounts/usage', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const query = await parseAndValidate(ctx.query, EngineAccountUsageQuery.strict());

    const service = ctx.container.get(EngineUsageService);
    const result: EngineAccountUsage[] = await service.usage(query);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});
