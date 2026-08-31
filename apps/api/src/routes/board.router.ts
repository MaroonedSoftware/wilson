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
    CreatePlanCommentRequest,
    DependCardRequest,
    EditCardRequest,
    ImportBoardRequest,
    ImportReport,
    ListQuery,
    MergeResult,
    MoveCardRequest,
    PlanComment,
    PlanDraft,
    PlanSession,
    PlanTurn,
    PlanTurnRequest,
    ReleaseResult,
    RenameCardRequest,
    RepositionCardRequest,
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
 * from [board.ck](file://./../../data/contracts/board.ck#L321)
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
 * from [board.ck](file://./../../data/contracts/board.ck#L330)
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
 * from [board.ck](file://./../../data/contracts/board.ck#L348)
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
 * from [board.ck](file://./../../data/contracts/board.ck#L361)
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
 * Card 0094. A sub-resource action, not `title` added to `EditCardRequest` (see the contract above):
 * renaming is still the same *kind* of act `PATCH .../id` already does — a human edits stored
 * content, no stage reads the field as input, nothing transitions — which is why this goes through
 * `board.write` in `BoardWriteService.rename`, not `writeWithEvent` the way `move` below does. It is
 * not part of `PATCH .../id` itself only because the contractkit-generated SDK method name for that
 * route (`editCardBody`) is pinned to "body", and a second field would force renaming it and every
 * caller for no behavioural gain.
 *
 * The title is not the runner state decision 5 protects, either: stage, branch and retries are
 * recomputed or read by the runner itself, and `move`/`ack`/etc. are the recorded ways to override
 * them. A title is authored prose nothing downstream depends on as input — the same reason `edit`
 * above is allowed to touch `body` freely.
 * from [board.ck](file://./../../data/contracts/board.ck#L392)
 * anonymous access, no security required
 */
BoardRouter.post('/api/cards/:id/rename', bodyParserMiddleware(['json']), async ctx => {
    const { id } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
        }),
    );

    const body = await parseAndValidate(ctx.parsedBody, RenameCardRequest);

    const service = ctx.container.get(BoardWriteService);
    const result: CardDetail = await service.rename(id, body);

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
 * from [board.ck](file://./../../data/contracts/board.ck#L423)
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
 * Card 0091. Carries the drag an operator made in the parking lot down to a stored `position` — the
 * one other thing this surface lets an operator set that is not runner state (see the comment on
 * `options.security` and decision 5: the runner owns stage, branch, retries; this owns nothing the
 * runner reads). Persists through `BoardRepository.setPosition`, not `write`/`writeWithEvent`: a
 * reposition mints no card version and writes no `transition.written` event, on purpose — dragging a
 * card three rows down did not change what the runner will do with it. Follows the same sub-resource
 * shape `move` established above.
 * from [board.ck](file://./../../data/contracts/board.ck#L452)
 * anonymous access, no security required
 */
BoardRouter.post('/api/cards/:id/reposition', bodyParserMiddleware(['json']), async ctx => {
    const { id } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
        }),
    );

    const body = await parseAndValidate(ctx.parsedBody, RepositionCardRequest);

    const service = ctx.container.get(BoardWriteService);
    const result: CardDetail = await service.reposition(id, body);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * Card 0080's other four mutations are pure transitions or a flag action; `depend` alone edits one
 * field (`dependsOn`) the way `PATCH .../id` edits `body` — it is still a POST action rather than a
 * PATCH because the edit is additive/subtractive (`remove`), not a full replace of the field the way
 * `EditCardRequest` replaces `body`.
 * from [board.ck](file://./../../data/contracts/board.ck#L479)
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
 * from [board.ck](file://./../../data/contracts/board.ck#L502)
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
 * from [board.ck](file://./../../data/contracts/board.ck#L521)
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
 * from [board.ck](file://./../../data/contracts/board.ck#L540)
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
 * from [board.ck](file://./../../data/contracts/board.ck#L559)
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
 * Card 0143. The merge the pipeline could never do by hand: compute the card's branch merged into
 * `main` without a checkout, prove it against the project's suite, and land it — or refuse and say
 * why. Reachable from the app rather than automatic on reaching `ready` (see this card's own
 * Constraints): the trigger stays an explicit operator action, the same human gate `ready` always
 * was, this endpoint just performs what a human used to type by hand.
 * from [board.ck](file://./../../data/contracts/board.ck#L583)
 * anonymous access, no security required
 */
BoardRouter.post('/api/cards/:id/merge', async ctx => {
    const { id } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
        }),
    );

    const service = ctx.container.get(BoardWriteService);
    const result: MergeResult = await service.merge(id);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * Card 0113. Reads without writing: renders the division a client would confirm, before anything is
 * created from it. Refuses, naming why, when there is nothing to act on rather than handing back an
 * empty confirmation prompt.
 * from [board.ck](file://./../../data/contracts/board.ck#L606)
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
 * from [board.ck](file://./../../data/contracts/board.ck#L632)
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
 * from [board.ck](file://./../../data/contracts/board.ck#L657)
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
 * Card 0140. A read, and nothing else: creates no session, cuts no worktree, writes nothing — `open`
 * remains the only thing that seeds a draft. A card in `planning` that has never had a session open
 * has no `draft.md` on disk yet; that is ordinary, not a server error, so it gets a 200 with an empty
 * `body` rather than a 404 — this surface's 404 already means "no such card" (see every other
 * operation here), and reusing it for "no draft yet" would leave a client unable to tell the two
 * apart without inspecting `details`. [[0138]] renders an empty draft the same way it renders any
 * other, with no special-case error path for a state that is completely normal.
 * from [board.ck](file://./../../data/contracts/board.ck#L681)
 * anonymous access, no security required
 */
BoardRouter.get('/api/cards/:id/plan/draft', async ctx => {
    const { id } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
        }),
    );

    const service = ctx.container.get(PlanService);
    const result: PlanDraft = await service.draft(id);

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
 * from [board.ck](file://./../../data/contracts/board.ck#L702)
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
 * from [board.ck](file://./../../data/contracts/board.ck#L726)
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
 * Card 0133: one turn of the conversation the daemon can now hold for a card in `planning`, instead
 * of that conversation existing only inside an operator's terminal (`wilson card plan`). This is the
 * ordinary JSON half of the pair; `GET .../plan/stream` (mounted by hand beside `FeedRouter`, not
 * generated — see routes.setup.ts) is where a client watches that same reply stream in as it is
 * written. Refused by exactly the two guards `open` applies: a card outside `planning`, or one whose
 * real branch already has work.
 * from [board.ck](file://./../../data/contracts/board.ck#L745)
 * anonymous access, no security required
 */
BoardRouter.post('/api/cards/:id/plan/turn', bodyParserMiddleware(['json']), async ctx => {
    const { id } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
        }),
    );

    const body = await parseAndValidate(ctx.parsedBody, PlanTurnRequest);

    const service = ctx.container.get(PlanService);
    const result: PlanTurn = await service.turn(id, body);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * Card 0146. Records an open comment on a passage of a card's plan draft — the anchor a client
 * already captured plus what the person said. Comments never touch `plan.md`, a card version or
 * the card body (PROJECT.md: only the resulting plan text binds downstream stages); they reach the
 * agent only as anchored instructions prepended to the card's next `POST .../plan/turn`.
 * from [board.ck](file://./../../data/contracts/board.ck#L769)
 * anonymous access, no security required
 */
BoardRouter.post('/api/cards/:id/plan/comments', bodyParserMiddleware(['json']), async ctx => {
    const { id } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
        }),
    );

    const body = await parseAndValidate(ctx.parsedBody, CreatePlanCommentRequest);

    const service = ctx.container.get(PlanService);
    const result: PlanComment = await service.addComment(id, body);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * Card 0146. Records an open comment on a passage of a card's plan draft — the anchor a client
 * already captured plus what the person said. Comments never touch `plan.md`, a card version or
 * the card body (PROJECT.md: only the resulting plan text binds downstream stages); they reach the
 * agent only as anchored instructions prepended to the card's next `POST .../plan/turn`.
 * from [board.ck](file://./../../data/contracts/board.ck#L782)
 * anonymous access, no security required
 */
BoardRouter.get('/api/cards/:id/plan/comments', async ctx => {
    const { id } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
        }),
    );

    const service = ctx.container.get(PlanService);
    const result: PlanComment[] = await service.comments(id);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * Card 0146. Marks one comment resolved — a state the comment moves through, not a delete; it
 * stays on record afterward, readable from `GET .../plan/comments`. The same 404 covers either id
 * not existing — the card, or a comment id not belonging to it.
 * from [board.ck](file://./../../data/contracts/board.ck#L802)
 * anonymous access, no security required
 */
BoardRouter.post('/api/cards/:id/plan/comments/:commentId/resolve', async ctx => {
    const { id, commentId } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
            commentId: z.string(),
        }),
    );

    const service = ctx.container.get(PlanService);
    const result: PlanComment = await service.resolveComment(id, commentId);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [board.ck](file://./../../data/contracts/board.ck#L818)
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
 * from [board.ck](file://./../../data/contracts/board.ck#L834)
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
 * from [board.ck](file://./../../data/contracts/board.ck#L847)
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
 * from [board.ck](file://./../../data/contracts/board.ck#L864)
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
 * from [board.ck](file://./../../data/contracts/board.ck#L884)
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
