import { z } from 'zod';
import { ServerKitRouter, bodyParserMiddleware, requirePolicy } from '@maroonedsoftware/koa';
import { EvalBatchesService } from '#modules/evals/eval.batches.service.js';
import { EvalFixturesService } from '#modules/evals/eval.fixtures.service.js';
import {
    CaptureEvalFixtureRequest,
    CreateEvalBatchRequest,
    EvalBatch,
    EvalBatchDetail,
    EvalFixture,
    EvalRunPatch,
    ListEvalBatchesQuery,
} from '../generated/evals.js';
import { parseAndValidate } from '@maroonedsoftware/zod';

/**
 * generated from [evals.ck](../../data/contracts/evals.ck)
 */
export const EvalsRouter = ServerKitRouter();

/**
 * from [evals.ck](../../data/contracts/evals.ck) `GET /api/evals/fixtures`
 */
EvalsRouter.get('/api/evals/fixtures', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const service = ctx.container.get(EvalFixturesService);
    const result: EvalFixture[] = await service.list();

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [evals.ck](../../data/contracts/evals.ck) `POST /api/evals/fixtures`
 */
EvalsRouter.post('/api/evals/fixtures', requirePolicy({ policy: 'wilson.manage' }), bodyParserMiddleware(['json']), async ctx => {
    const body = await parseAndValidate(ctx.parsedBody, CaptureEvalFixtureRequest);

    const service = ctx.container.get(EvalFixturesService);
    const result: EvalFixture = await service.capture(body);

    ctx.status = 201;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [evals.ck](../../data/contracts/evals.ck) `DELETE /api/evals/fixtures/{id}`
 */
EvalsRouter.delete('/api/evals/fixtures/:id', requirePolicy({ policy: 'wilson.manage' }), async ctx => {
    const { id } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
        }),
    );

    const service = ctx.container.get(EvalFixturesService);
    await service.remove(id);

    ctx.status = 204;
});

/**
 * Starting a batch needs `wilson.step.up`, as saving a lane does: it spends tokens and runs a config
 * nobody has saved, so a leaked `manage` key must not be able to.
 * from [evals.ck](../../data/contracts/evals.ck) `GET /api/evals/batches`
 */
EvalsRouter.get('/api/evals/batches', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const query = await parseAndValidate(ctx.query, ListEvalBatchesQuery.strict());

    const service = ctx.container.get(EvalBatchesService);
    const result: EvalBatch[] = await service.list(query);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * Starting a batch needs `wilson.step.up`, as saving a lane does: it spends tokens and runs a config
 * nobody has saved, so a leaked `manage` key must not be able to.
 * from [evals.ck](../../data/contracts/evals.ck) `POST /api/evals/batches`
 */
EvalsRouter.post('/api/evals/batches', requirePolicy({ policy: 'wilson.step.up' }), bodyParserMiddleware(['json']), async ctx => {
    const body = await parseAndValidate(ctx.parsedBody, CreateEvalBatchRequest);

    const service = ctx.container.get(EvalBatchesService);
    const result: EvalBatchDetail = await service.create(body);

    ctx.status = 201;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [evals.ck](../../data/contracts/evals.ck) `GET /api/evals/batches/{id}`
 */
EvalsRouter.get('/api/evals/batches/:id', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const { id } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
        }),
    );

    const service = ctx.container.get(EvalBatchesService);
    const result: EvalBatchDetail = await service.show(id);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * What has not started is skipped. A run in progress finishes and is kept.
 * from [evals.ck](../../data/contracts/evals.ck) `POST /api/evals/batches/{id}/stop`
 */
EvalsRouter.post('/api/evals/batches/:id/stop', requirePolicy({ policy: 'wilson.manage' }), async ctx => {
    const { id } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
        }),
    );

    const service = ctx.container.get(EvalBatchesService);
    const result: EvalBatchDetail = await service.stop(id);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * What a run left in its tree, cut at 256 KB. Empty for a run that changed nothing.
 * from [evals.ck](../../data/contracts/evals.ck) `GET /api/evals/runs/{id}/patch`
 */
EvalsRouter.get('/api/evals/runs/:id/patch', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const { id } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
        }),
    );

    const service = ctx.container.get(EvalBatchesService);
    const result: EvalRunPatch = await service.patch(id);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});
