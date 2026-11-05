import { z } from 'zod';
import { ServerKitRouter, bodyParserMiddleware, requirePolicy } from '@maroonedsoftware/koa';
import { AppsService } from '#modules/apps/apps.service.js';
import { App, AppSummary, InstallAppRequest } from '../generated/apps.js';
import { parseAndValidate } from '@maroonedsoftware/zod';

/**
 * generated from [apps.ck](../../data/contracts/apps.ck)
 */
export const AppsRouter = ServerKitRouter();

/**
 * from [apps.ck](../../data/contracts/apps.ck) `GET /api/apps`
 */
AppsRouter.get('/api/apps', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const service = ctx.container.get(AppsService);
    const result: AppSummary[] = await service.list();

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [apps.ck](../../data/contracts/apps.ck) `GET /api/apps/{slug}`
 */
AppsRouter.get('/api/apps/:slug', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const { slug } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            slug: z.string(),
        }),
    );

    const service = ctx.container.get(AppsService);
    const result: App = await service.get(slug);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * Install an app under this slug, or replace the one already there. `createdAt` survives a replace.
 * from [apps.ck](../../data/contracts/apps.ck) `PUT /api/apps/{slug}`
 */
AppsRouter.put('/api/apps/:slug', requirePolicy({ policy: 'wilson.step.up' }), bodyParserMiddleware(['json']), async ctx => {
    const { slug } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            slug: z.string(),
        }),
    );

    const body = await parseAndValidate(ctx.parsedBody, InstallAppRequest);

    const service = ctx.container.get(AppsService);
    const result: App = await service.install(slug, body);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [apps.ck](../../data/contracts/apps.ck) `DELETE /api/apps/{slug}`
 */
AppsRouter.delete('/api/apps/:slug', requirePolicy({ policy: 'wilson.step.up' }), async ctx => {
    const { slug } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            slug: z.string(),
        }),
    );

    const service = ctx.container.get(AppsService);
    await service.remove(slug);

    ctx.status = 204;
});
