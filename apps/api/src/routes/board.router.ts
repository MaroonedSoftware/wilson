import { z } from 'zod';
import { ServerKitRouter, bodyParserMiddleware } from '@maroonedsoftware/koa';
import { BoardBootstrapService } from '#modules/board/board.bootstrap.service.js';
import { BoardService } from '#modules/board/board.service.js';
import { BoardWriteService } from '#modules/board/board.write.service.js';
import { PlanService } from '#modules/plan/plan.service.js';
import { StagesService } from '#modules/stages/stages.service.js';
import {
    BoardColumns,
    CardDetail,
    CardDivision,
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
    PlanSession,
    ReleaseResult,
    SaveDraftRequest,
    SplitCardsRequest,
    SplitResult,
} from '../generated/board.js';
import { parseAndValidate } from '@maroonedsoftware/zod';

/**
 * generated from [board.ck](file://./../../data/contracts/board.ck)
 */
export const BoardRouter = ServerKitRouter();

/**
 * from [board.ck](file://./../../data/contracts/board.ck#L214)
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
 * from [board.ck](file://./../../data/contracts/board.ck#L223)
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
 * from [board.ck](file://./../../data/contracts/board.ck#L241)
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
 * from [board.ck](file://./../../data/contracts/board.ck#L254)
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
 * from [board.ck](file://./../../data/contracts/board.ck#L278)
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
 * from [board.ck](file://./../../data/contracts/board.ck#L305)
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
 * from [board.ck](file://./../../data/contracts/board.ck#L328)
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
 * from [board.ck](file://./../../data/contracts/board.ck#L347)
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
 * from [board.ck](file://./../../data/contracts/board.ck#L366)
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
 * from [board.ck](file://./../../data/contracts/board.ck#L385)
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
    const result: ReleaseResult = await service.release(id);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * Card 0113. Reads without writing: renders the division a client would confirm, before anything is
 * created from it. Refuses, naming why, when there is nothing to act on rather than handing back an
 * empty confirmation prompt.
 * from [board.ck](file://./../../data/contracts/board.ck#L407)
 * anonymous access, no security required
 */
BoardRouter.get('/api/cards/:id/division', async ctx => {
    const { id } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
        }),
    );

    const service = ctx.container.get(BoardWriteService);
    const result: CardDivision = await service.division(id);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * Card 0113. Creates one card per confirmed piece, in `planning`, records the dependencies named in
 * each piece's `dependsOn`, and annotates the origin card with the ids it produced. Never moves or
 * drops the origin — card [[0090]]'s lesson about stranding dependents applies here too, and the
 * pieces themselves are what would strand — and never re-runs `scope-check` on what it creates:
 * deciding a split is `scope-check`'s job (card 0105), this only acts on a division an operator
 * already confirmed.
 * from [board.ck](file://./../../data/contracts/board.ck#L433)
 * anonymous access, no security required
 */
BoardRouter.post('/api/cards/:id/split', bodyParserMiddleware(['json']), async ctx => {
    const { id } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
        }),
    );

    const body = await parseAndValidate(ctx.parsedBody, SplitCardsRequest);

    const service = ctx.container.get(BoardWriteService);
    const result: SplitResult = await service.split(id, body);

    ctx.status = 201;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * Runs card 0058's two guards before cutting anything: refuses a card that is not in `planning`, and
 * refuses one whose real branch already has work (re-planning a card with code on it is a different,
 * more dangerous operation). Cuts nothing on a refusal.
 * from [board.ck](file://./../../data/contracts/board.ck#L458)
 * anonymous access, no security required
 */
BoardRouter.post('/api/cards/:id/plan/open', async ctx => {
    const { id } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
        }),
    );

    const service = ctx.container.get(PlanService);
    const result: PlanSession = await service.open(id);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * Validates the six `PLAN_SECTIONS` headings and a non-empty "Files in scope" server-side — the same
 * refusal `wilson card plan` makes before writing today, and it must not become something a client
 * can skip, since skipping it is what let a card die at `assertDispatchable` three stages later
 * (card 0058). Refuses naming what is missing. Writes exactly one new card version on success; an
 * unchanged body writes nothing, the same no-op `BoardWriteService.edit` already makes.
 * from [board.ck](file://./../../data/contracts/board.ck#L480)
 * anonymous access, no security required
 */
BoardRouter.post('/api/cards/:id/plan/save', bodyParserMiddleware(['json']), async ctx => {
    const { id } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
        }),
    );

    const body = await parseAndValidate(ctx.parsedBody, SaveDraftRequest);

    const service = ctx.container.get(PlanService);
    const result: CardDetail = await service.save(id, body);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * Reclaims the session's worktree and deletes its throwaway branch. Idempotent — safe to call twice,
 * and safe to call for a session that opened but was never saved — because that is exactly what a CLI
 * dying mid-conversation leaves behind, and closing it must never itself be the operation that fails.
 * from [board.ck](file://./../../data/contracts/board.ck#L504)
 * anonymous access, no security required
 */
BoardRouter.post('/api/cards/:id/plan/close', async ctx => {
    const { id } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
        }),
    );

    const service = ctx.container.get(PlanService);
    await service.close(id);

    ctx.status = 204;
});

/**
 * from [board.ck](file://./../../data/contracts/board.ck#L517)
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
 * from [board.ck](file://./../../data/contracts/board.ck#L533)
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
 * from [board.ck](file://./../../data/contracts/board.ck#L546)
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
 * from [board.ck](file://./../../data/contracts/board.ck#L563)
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
 * from [board.ck](file://./../../data/contracts/board.ck#L583)
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
