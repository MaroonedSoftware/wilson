import { z } from 'zod';
import { ServerKitRouter, requirePolicy } from '@maroonedsoftware/koa';
import { AppApiService } from '#modules/apps/app.api.service.js';
import {
    AppV1ActivityEvent,
    AppV1ActivityQuery,
    AppV1BoardColumns,
    AppV1Card,
    AppV1CardDetail,
    AppV1Stats,
    AppV1StatsQuery,
} from '../generated/app.api.js';
import { parseAndValidate } from '@maroonedsoftware/zod';

/**
 * generated from [app.api.ck](../../data/contracts/app.api.ck)
 */
export const AppApiRouter = ServerKitRouter();

/**
 * from [app.api.ck](../../data/contracts/app.api.ck) `GET /api/app-api/v1/cards`
 */
AppApiRouter.get('/api/app-api/v1/cards', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const service = ctx.container.get(AppApiService);
    const result: AppV1Card[] = await service.listCards();

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [app.api.ck](../../data/contracts/app.api.ck) `GET /api/app-api/v1/cards/{id}`
 */
AppApiRouter.get('/api/app-api/v1/cards/:id', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const { id } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
        }),
    );

    const service = ctx.container.get(AppApiService);
    const result: AppV1CardDetail = await service.getCard(id);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [app.api.ck](../../data/contracts/app.api.ck) `GET /api/app-api/v1/columns`
 */
AppApiRouter.get('/api/app-api/v1/columns', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const service = ctx.container.get(AppApiService);
    const result: AppV1BoardColumns = await service.listBoardColumns();

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [app.api.ck](../../data/contracts/app.api.ck) `GET /api/app-api/v1/activity`
 */
AppApiRouter.get('/api/app-api/v1/activity', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const query = await parseAndValidate(ctx.query, AppV1ActivityQuery.strict());

    const service = ctx.container.get(AppApiService);
    const result: AppV1ActivityEvent[] = await service.listProjectActivity(query);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [app.api.ck](../../data/contracts/app.api.ck) `GET /api/app-api/v1/stats`
 */
AppApiRouter.get('/api/app-api/v1/stats', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const query = await parseAndValidate(ctx.query, AppV1StatsQuery.strict());

    const service = ctx.container.get(AppApiService);
    const result: AppV1Stats = await service.getProjectStats(query);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});
