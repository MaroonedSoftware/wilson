import { z } from 'zod';
import { ServerKitRouter, bodyParserMiddleware } from '@maroonedsoftware/koa';
import { BoardService } from '#modules/board/board.service.js';
import { BoardWriteService } from '#modules/board/board.write.service.js';
import { StagesService } from '#modules/stages/stages.service.js';
import {
    BoardColumns,
    CardDetail,
    CardEvent,
    CardSummary,
    CardVersion,
    CreateCardRequest,
    EditCardRequest,
    ListQuery,
    MoveCardRequest,
} from '../generated/board.js';
import { parseAndValidate } from '@maroonedsoftware/zod';

/**
 * generated from [board.ck](file://./../../data/contracts/board.ck)
 */
export const BoardRouter = ServerKitRouter();

/**
 * from [board.ck](file://./../../data/contracts/board.ck#L94)
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
 * from [board.ck](file://./../../data/contracts/board.ck#L103)
 * anonymous access, no security required
 */
BoardRouter.post('/api/cards', bodyParserMiddleware(['json']), async ctx => {
    const body = await parseAndValidate(ctx.parsedBody, CreateCardRequest);

    const service = ctx.container.get(BoardWriteService);
    const result: CardDetail = await service.create(body);

    ctx.status = 201;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [board.ck](file://./../../data/contracts/board.ck#L121)
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
 * Not `put`. This is a partial update — only the body changes, frontmatter is not editable here
 * (decision 5: stage, branch, retries are runner state; `move` is the recorded way to override
 * stage) — which is exactly what `patch` means and `put`, a full replace, does not.
 * from [board.ck](file://./../../data/contracts/board.ck#L134)
 * anonymous access, no security required
 */
BoardRouter.patch('/api/cards/:id', bodyParserMiddleware(['json']), async ctx => {
    const { id } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
        }),
    );

    const body = await parseAndValidate(ctx.parsedBody, EditCardRequest);

    const service = ctx.container.get(BoardWriteService);
    const result: CardDetail = await service.edit(id, body);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * A sub-resource action rather than `PATCH /api/cards/{id}` with a `stage` field: a move is a
 * recorded transition with its own event (`writeWithEvent`), not an edit to a stored field, and card
 * 0080's other five mutations — depend, ack, approve, start, release — are transitions of exactly
 * this shape. `POST .../move` establishes that convention once so five more operations can copy it
 * rather than each inventing its own.
 * from [board.ck](file://./../../data/contracts/board.ck#L158)
 * anonymous access, no security required
 */
BoardRouter.post('/api/cards/:id/move', bodyParserMiddleware(['json']), async ctx => {
    const { id } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
        }),
    );

    const body = await parseAndValidate(ctx.parsedBody, MoveCardRequest);

    const service = ctx.container.get(BoardWriteService);
    const result: CardDetail = await service.move(id, body);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [board.ck](file://./../../data/contracts/board.ck#L180)
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
 * from [board.ck](file://./../../data/contracts/board.ck#L196)
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

/**
 * from [board.ck](file://./../../data/contracts/board.ck#L209)
 * anonymous access, no security required
 */
BoardRouter.get('/api/stages', async ctx => {
    const service = ctx.container.get(StagesService);
    const result: BoardColumns = await service.columns();

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});
