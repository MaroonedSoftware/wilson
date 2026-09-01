import { ServerKitRouter, bodyParserMiddleware } from '@maroonedsoftware/koa';
import { StageConfigService } from '#modules/stages/stage.config.service.js';
import { SetStageConfigRequest, StageConfigDocument, StageConfigVersion, StageConfigVersionsQuery } from '../generated/stages.js';
import { parseAndValidate } from '@maroonedsoftware/zod';

/**
 * generated from [stages.ck](file://./../../data/contracts/stages.ck)
 */
export const StagesRouter = ServerKitRouter();

/**
 * from [stages.ck](file://./../../data/contracts/stages.ck#L55)
 * anonymous access, no security required
 */
StagesRouter.get('/api/stages/config', async ctx => {
    const service = ctx.container.get(StageConfigService);
    const result: StageConfigDocument = await service.get();

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * `put`, not `patch`: the document is replaced whole. Every save is a new row; the previous
 * document is still there in the history, so a bad edit is undone by saving the earlier text
 * again, never by deleting anything.
 * from [stages.ck](file://./../../data/contracts/stages.ck#L70)
 * anonymous access, no security required
 */
StagesRouter.put('/api/stages/config', bodyParserMiddleware(['json']), async ctx => {
    const body = await parseAndValidate(ctx.parsedBody, SetStageConfigRequest);

    const service = ctx.container.get(StageConfigService);
    const result: StageConfigDocument = await service.set(body);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [stages.ck](file://./../../data/contracts/stages.ck#L89)
 * anonymous access, no security required
 */
StagesRouter.get('/api/stages/config/versions', async ctx => {
    const query = await parseAndValidate(ctx.query, StageConfigVersionsQuery.strict());

    const service = ctx.container.get(StageConfigService);
    const result: StageConfigVersion[] = await service.versions(query);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});
