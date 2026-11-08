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
    RenameEngineTokenRequest,
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
 * A sub-resource action rather than a `name` field on `UpdateEngineTokenRequest`, which would change
 * what the generated `updateEngineToken` means for every caller. The name is the key, so this is the
 * only way to change it without removing the token and saving it again, which loses it: the token
 * cannot be read back.
 *
 * What moves: the token's own row, and the assignment of every worker host that holds it — the latter
 * by the foreign key's `ON UPDATE CASCADE`, not by a second write. What does not: the token itself, its
 * `provider`, `kind`, `priority`, `pooled`, `createdAt` and `updatedAt` (a rename is not a re-save);
 * recorded spend, which keeps the old name, so `GET /api/engine-accounts/usage` lists the old and the
 * new name separately for a window that straddles a rename; and a usage limit in force, which stays
 * recorded against the old name. Renaming to the current name is a no-op, not an error.
 *
 * A rename does not reach a running engine. An engine is started with the account name resolved then
 * and handed the token's value, never its name, so a run in flight carries on untouched and the next
 * engine started gets the new name. A limit a running engine reports after the rename is therefore
 * recorded against the old name: it shows as a stray account in `GET /api/engine-limits` until it
 * resets, and the renamed account shows no badge for it — as `put` never reaches a running engine
 * either.
 * from [engine.tokens.ck](../../data/contracts/engine.tokens.ck) `POST /api/engine-tokens/{name}/rename`
 */
EngineTokensRouter.post('/api/engine-tokens/:name/rename', requirePolicy({ policy: 'wilson.manage' }), bodyParserMiddleware(['json']), async ctx => {
    const { name } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            name: z.string(),
        }),
    );

    const body = await parseAndValidate(ctx.parsedBody, RenameEngineTokenRequest);

    const service = ctx.container.get(EngineTokensService);
    const result: EngineTokenSummary = await service.rename(name, body);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
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
