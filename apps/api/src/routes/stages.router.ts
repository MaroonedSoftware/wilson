import { z } from 'zod';
import { ServerKitRouter, bodyParserMiddleware, requirePolicy } from '@maroonedsoftware/koa';
import { StageConfigService } from '#modules/stages/stage.config.service.js';
import { Lane, LaneRevision, LaneRevisionsQuery, PatchLaneRequest, SetStageRoutingRequest, StageRouting } from '../generated/stages.js';
import { parseAndValidate } from '@maroonedsoftware/zod';

/**
 * generated from [stages.ck](../../data/contracts/stages.ck)
 */
export const StagesRouter = ServerKitRouter();

/**
 * from [stages.ck](../../data/contracts/stages.ck) `GET /api/stages/lanes`
 */
StagesRouter.get('/api/stages/lanes', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const service = ctx.container.get(StageConfigService);
    const result: Lane[] = await service.lanes();

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [stages.ck](../../data/contracts/stages.ck) `PATCH /api/stages/lanes/{name}`
 */
StagesRouter.patch('/api/stages/lanes/:name', requirePolicy({ policy: 'wilson.step.up' }), bodyParserMiddleware(['json']), async ctx => {
    const { name } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            name: z.string(),
        }),
    );

    const body = await parseAndValidate(ctx.parsedBody, PatchLaneRequest);

    const service = ctx.container.get(StageConfigService);
    const result: Lane = await service.patchLane(name, body);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [stages.ck](../../data/contracts/stages.ck) `GET /api/stages/lane-revisions`
 */
StagesRouter.get('/api/stages/lane-revisions', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const query = await parseAndValidate(ctx.query, LaneRevisionsQuery.strict());

    const service = ctx.container.get(StageConfigService);
    const result: LaneRevision[] = await service.laneRevisions(query);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [stages.ck](../../data/contracts/stages.ck) `GET /api/stages/routing`
 */
StagesRouter.get('/api/stages/routing', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const service = ctx.container.get(StageConfigService);
    const result: StageRouting[] = await service.routing();

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * One lane at a time. Behind step-up for the same reason lane edits are, and
 * because an agent that could choose its own model could choose the most expensive one.
 * from [stages.ck](../../data/contracts/stages.ck) `PUT /api/stages/routing/{stage}`
 */
StagesRouter.put('/api/stages/routing/:stage', requirePolicy({ policy: 'wilson.step.up' }), bodyParserMiddleware(['json']), async ctx => {
    const { stage } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            stage: z.string(),
        }),
    );

    const body = await parseAndValidate(ctx.parsedBody, SetStageRoutingRequest);

    const service = ctx.container.get(StageConfigService);
    const result: StageRouting = await service.setRouting(stage, body);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});
