import { ServerKitRouter, bodyParserMiddleware } from '@maroonedsoftware/koa';
import { LearningsService } from '#modules/learnings/learnings.service.js';
import { LearningsDocument, LearningsVersion, LearningsVersionsQuery, SetLearningsRequest } from '../generated/learnings.js';
import { parseAndValidate } from '@maroonedsoftware/zod';

/**
 * generated from [learnings.ck](file://./../../data/contracts/learnings.ck)
 */
export const LearningsRouter = ServerKitRouter();

/**
 * from [learnings.ck](file://./../../data/contracts/learnings.ck#L49)
 * anonymous access, no security required
 */
LearningsRouter.get('/api/learnings', async ctx => {
    const service = ctx.container.get(LearningsService);
    const result: LearningsDocument = await service.get();

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * `put`, not `patch`: the document is replaced whole. Every save is a new row; the previous
 * document is still there in the history, so a bad edit is undone by saving the earlier text
 * again, never by deleting anything. An empty `markdown` is a valid save.
 * from [learnings.ck](file://./../../data/contracts/learnings.ck#L61)
 * anonymous access, no security required
 */
LearningsRouter.put('/api/learnings', bodyParserMiddleware(['json']), async ctx => {
    const body = await parseAndValidate(ctx.parsedBody, SetLearningsRequest);

    const service = ctx.container.get(LearningsService);
    const result: LearningsDocument = await service.set(body);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [learnings.ck](file://./../../data/contracts/learnings.ck#L76)
 * anonymous access, no security required
 */
LearningsRouter.get('/api/learnings/versions', async ctx => {
    const query = await parseAndValidate(ctx.query, LearningsVersionsQuery.strict());

    const service = ctx.container.get(LearningsService);
    const result: LearningsVersion[] = await service.versions(query);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});
