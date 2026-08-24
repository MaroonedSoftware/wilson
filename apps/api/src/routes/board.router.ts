import { z } from 'zod';
import { ServerKitRouter } from '@maroonedsoftware/koa';
import { BoardService } from '#modules/board/board.service.js';
import { CardDetail, CardEvent, CardSummary, CardVersion, ListQuery } from '../generated/board.js';
import { parseAndValidate } from '@maroonedsoftware/zod';

/**
 * generated from [board.ck](file://./../../data/contracts/board.ck)
 */
export const BoardRouter = ServerKitRouter();

/**
 * from [board.ck](file://./../../data/contracts/board.ck#L45)
 * anonymous access, no security required
 */
BoardRouter.get('/api/cards', async ctx => {
    const service = ctx.container.get(BoardService);
    const result: CardSummary[] = await service.list();

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [board.ck](file://./../../data/contracts/board.ck#L60)
 * anonymous access, no security required
 */
BoardRouter.get('/api/cards/:id', async ctx => {
    const { id } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
        }),
    );

    const service = ctx.container.get(BoardService);
    const result: CardDetail = await service.getById(id);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [board.ck](file://./../../data/contracts/board.ck#L76)
 * anonymous access, no security required
 */
BoardRouter.get('/api/cards/:id/events', async ctx => {
    const { id } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
        }),
    );

    const query = await parseAndValidate(ctx.query, ListQuery.strict());

    const service = ctx.container.get(BoardService);
    const result: CardEvent[] = await service.events(id, query);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [board.ck](file://./../../data/contracts/board.ck#L92)
 * anonymous access, no security required
 */
BoardRouter.get('/api/cards/:id/versions', async ctx => {
    const { id } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
        }),
    );

    const query = await parseAndValidate(ctx.query, ListQuery.strict());

    const service = ctx.container.get(BoardService);
    const result: CardVersion[] = await service.versions(id, query);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});
