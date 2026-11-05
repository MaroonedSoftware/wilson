import { z } from 'zod';
import { ServerKitRouter, bodyParserMiddleware, requirePolicy } from '@maroonedsoftware/koa';
import { EvalFixturesService } from '#modules/evals/eval.fixtures.service.js';
import { CaptureEvalFixtureRequest, EvalFixture } from '../generated/evals.js';
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
