import { z } from 'zod';
import { ServerKitRouter, bodyParserMiddleware } from '@maroonedsoftware/koa';
import { BoardBootstrapService } from '#modules/board/board.bootstrap.service.js';
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
    DependCardRequest,
    EditCardRequest,
    ImportBoardRequest,
    ImportReport,
    ListQuery,
    MoveCardRequest,
} from '../generated/board.js';
import { parseAndValidate } from '@maroonedsoftware/zod';

/**
 * generated from [board.ck](file://./../../data/contracts/board.ck)
 */
export const BoardRouter = ServerKitRouter();

/**
 * from [board.ck](file://./../../data/contracts/board.ck#L121)
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
 * from [board.ck](file://./../../data/contracts/board.ck#L130)
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
 * from [board.ck](file://./../../data/contracts/board.ck#L148)
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
 * from [board.ck](file://./../../data/contracts/board.ck#L161)
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
 * from [board.ck](file://./../../data/contracts/board.ck#L185)
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
 * Card 0080's other four mutations are pure transitions or a flag action; `depend` alone edits one
 * field (`dependsOn`) the way `PATCH .../id` edits `body` — it is still a POST action rather than a
 * PATCH because the edit is additive/subtractive (`remove`), not a full replace of the field the way
 * `EditCardRequest` replaces `body`.
 * from [board.ck](file://./../../data/contracts/board.ck#L212)
 * anonymous access, no security required
 */
BoardRouter.post('/api/cards/:id/depend', bodyParserMiddleware(['json']), async ctx => {
    const { id } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
        }),
    );

    const body = await parseAndValidate(ctx.parsedBody, DependCardRequest);

    const service = ctx.container.get(BoardWriteService);
    const result: CardDetail = await service.depend(id, body);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [board.ck](file://./../../data/contracts/board.ck#L235)
 * anonymous access, no security required
 */
BoardRouter.post('/api/cards/:id/ack', async ctx => {
    const { id } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
        }),
    );

    const service = ctx.container.get(BoardWriteService);
    const result: CardDetail = await service.ack(id);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [board.ck](file://./../../data/contracts/board.ck#L254)
 * anonymous access, no security required
 */
BoardRouter.post('/api/cards/:id/approve', async ctx => {
    const { id } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
        }),
    );

    const service = ctx.container.get(BoardWriteService);
    const result: CardDetail = await service.approve(id);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [board.ck](file://./../../data/contracts/board.ck#L273)
 * anonymous access, no security required
 */
BoardRouter.post('/api/cards/:id/start', async ctx => {
    const { id } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
        }),
    );

    const service = ctx.container.get(BoardWriteService);
    const result: CardDetail = await service.start(id);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [board.ck](file://./../../data/contracts/board.ck#L292)
 * anonymous access, no security required
 */
BoardRouter.post('/api/cards/:id/release', async ctx => {
    const { id } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
        }),
    );

    const service = ctx.container.get(BoardWriteService);
    const result: CardDetail = await service.release(id);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [board.ck](file://./../../data/contracts/board.ck#L311)
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
 * from [board.ck](file://./../../data/contracts/board.ck#L327)
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
 * from [board.ck](file://./../../data/contracts/board.ck#L340)
 * anonymous access, no security required
 */
BoardRouter.get('/api/stages', async ctx => {
    const service = ctx.container.get(StagesService);
    const result: BoardColumns = await service.columns();

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * Scaffolds `BoardConfig.boardRoot`: cards/, config/, context/, a stages.yaml an operator can start a
 * card against immediately, and a git repo to commit it into. The API has to be running, with
 * PROJECT_BOARD_ROOT already pointing at the intended path, before it can create the board there —
 * that circularity is real, and the 409 below is what makes it legible instead of a connection
 * refused with no explanation.
 * from [board.ck](file://./../../data/contracts/board.ck#L357)
 * anonymous access, no security required
 */
BoardRouter.post('/api/board/init', async ctx => {
    const service = ctx.container.get(BoardBootstrapService);
    const result: BoardColumns = await service.init();

    ctx.status = 201;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * One-time import of the legacy markdown board (cards/*.md) into Postgres. Refuses a board that
 * already has cards, the same guard `BoardImporter` always made, over HTTP now rather than only
 * from the CLI.
 * from [board.ck](file://./../../data/contracts/board.ck#L377)
 * anonymous access, no security required
 */
BoardRouter.post('/api/board/import', bodyParserMiddleware(['json']), async ctx => {
    const body = await parseAndValidate(ctx.parsedBody, ImportBoardRequest);

    const service = ctx.container.get(BoardBootstrapService);
    const result: ImportReport = await service.import(body);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});
