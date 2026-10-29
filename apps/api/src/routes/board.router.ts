import { z } from 'zod';
import { ServerKitRouter, bodyParserMiddleware, requirePolicy } from '@maroonedsoftware/koa';
import { BoardBootstrapService } from '#modules/board/board.bootstrap.service.js';
import { BoardService } from '#modules/board/board.service.js';
import { BoardWriteService } from '#modules/board/board.write.service.js';
import { PlanLintService } from '#modules/board/plan.lint.service.js';
import { PlanService } from '#modules/plan/plan.service.js';
import { StagesService } from '#modules/stages/stages.service.js';
import {
    BoardColumns,
    CardDetail,
    CardDiff,
    CardDivision,
    CardEvent,
    CardSummary,
    CardUsage,
    CardVersion,
    CreateCardRequest,
    CreatePlanCommentRequest,
    DependCardRequest,
    EditCardRequest,
    LintFinding,
    ListQuery,
    MergeResult,
    MoveCardRequest,
    PlanComment,
    PlanDraft,
    PlanSession,
    PlanTurn,
    PlanTurnRequest,
    RecordFindingsRequest,
    ReleaseResult,
    RenameCardRequest,
    RepositionCardRequest,
    SaveDraftRequest,
    SplitCardsRequest,
    SplitResult,
} from '../generated/board.js';
import { parseAndValidate } from '@maroonedsoftware/zod';

/**
 * generated from [board.ck](../../data/contracts/board.ck)
 */
export const BoardRouter = ServerKitRouter();

/**
 * from [board.ck](../../data/contracts/board.ck) `GET /api/cards`
 */
BoardRouter.get('/api/cards', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const service = ctx.container.get(BoardService);
    const result: CardSummary[] = await service.list();

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [board.ck](../../data/contracts/board.ck) `POST /api/cards`
 */
BoardRouter.post('/api/cards', requirePolicy({ policy: 'wilson.manage' }), bodyParserMiddleware(['json']), async ctx => {
    const body = await parseAndValidate(ctx.parsedBody, CreateCardRequest);

    const service = ctx.container.get(BoardWriteService);
    const result: CardDetail = await service.create(body);

    ctx.status = 201;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [board.ck](../../data/contracts/board.ck) `GET /api/cards/{id}`
 */
BoardRouter.get('/api/cards/:id', requirePolicy({ policy: 'wilson.view' }), async ctx => {
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
 * from [board.ck](../../data/contracts/board.ck) `PATCH /api/cards/{id}`
 */
BoardRouter.patch('/api/cards/:id', requirePolicy({ policy: 'wilson.manage' }), bodyParserMiddleware(['json']), async ctx => {
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
 * from [board.ck](../../data/contracts/board.ck) `POST /api/cards/{id}/rename`
 */
BoardRouter.post('/api/cards/:id/rename', requirePolicy({ policy: 'wilson.manage' }), bodyParserMiddleware(['json']), async ctx => {
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
 * from [board.ck](../../data/contracts/board.ck) `POST /api/cards/{id}/move`
 */
BoardRouter.post('/api/cards/:id/move', requirePolicy({ policy: 'wilson.manage' }), bodyParserMiddleware(['json']), async ctx => {
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
 * from [board.ck](../../data/contracts/board.ck) `POST /api/cards/{id}/reposition`
 */
BoardRouter.post('/api/cards/:id/reposition', requirePolicy({ policy: 'wilson.manage' }), bodyParserMiddleware(['json']), async ctx => {
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
 * from [board.ck](../../data/contracts/board.ck) `POST /api/cards/{id}/depend`
 */
BoardRouter.post('/api/cards/:id/depend', requirePolicy({ policy: 'wilson.manage' }), bodyParserMiddleware(['json']), async ctx => {
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
 * from [board.ck](../../data/contracts/board.ck) `POST /api/cards/{id}/ack`
 */
BoardRouter.post('/api/cards/:id/ack', requirePolicy({ policy: 'wilson.manage' }), async ctx => {
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
 * from [board.ck](../../data/contracts/board.ck) `POST /api/cards/{id}/approve`
 */
BoardRouter.post('/api/cards/:id/approve', requirePolicy({ policy: 'wilson.manage' }), async ctx => {
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
 * from [board.ck](../../data/contracts/board.ck) `POST /api/cards/{id}/start`
 */
BoardRouter.post('/api/cards/:id/start', requirePolicy({ policy: 'wilson.manage' }), async ctx => {
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
 * from [board.ck](../../data/contracts/board.ck) `POST /api/cards/{id}/release`
 */
BoardRouter.post('/api/cards/:id/release', requirePolicy({ policy: 'wilson.manage' }), async ctx => {
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
 * from [board.ck](../../data/contracts/board.ck) `POST /api/cards/{id}/merge`
 */
BoardRouter.post('/api/cards/:id/merge', requirePolicy({ policy: 'wilson.manage' }), async ctx => {
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
 * from [board.ck](../../data/contracts/board.ck) `GET /api/cards/{id}/division`
 */
BoardRouter.get('/api/cards/:id/division', requirePolicy({ policy: 'wilson.view' }), async ctx => {
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
 * from [board.ck](../../data/contracts/board.ck) `POST /api/cards/{id}/split`
 */
BoardRouter.post('/api/cards/:id/split', requirePolicy({ policy: 'wilson.manage' }), bodyParserMiddleware(['json']), async ctx => {
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
 * Card 0193. Checks a plan against the config the runner will actually enforce — a stage's
 * `CommandAllowlist`, the project's `alwaysAllowed` list, the literal shape of a `Files in scope`
 * line — and reports what it finds. Read-only, like `division` above: nothing here blocks `approve`
 * or any other transition (see `PlanLintService`'s own doc comment for why), so a client is free to
 * call this whenever it wants a second opinion, not only right before approving.
 * from [board.ck](../../data/contracts/board.ck) `GET /api/cards/{id}/lint`
 */
BoardRouter.get('/api/cards/:id/lint', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const { id } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
        }),
    );

    const service = ctx.container.get(PlanLintService);
    const result: LintFinding[] = await service.lint(id);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * Runs card 0058's two guards before cutting anything: refuses a card that is not in `planning`, and
 * refuses one whose real branch already has work (re-planning a card with code on it is a different,
 * more dangerous operation). Cuts nothing on a refusal.
 * from [board.ck](../../data/contracts/board.ck) `POST /api/cards/{id}/plan/open`
 */
BoardRouter.post('/api/cards/:id/plan/open', requirePolicy({ policy: 'wilson.manage' }), async ctx => {
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
 * from [board.ck](../../data/contracts/board.ck) `GET /api/cards/{id}/plan/draft`
 */
BoardRouter.get('/api/cards/:id/plan/draft', requirePolicy({ policy: 'wilson.view' }), async ctx => {
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
 * from [board.ck](../../data/contracts/board.ck) `POST /api/cards/{id}/plan/save`
 */
BoardRouter.post('/api/cards/:id/plan/save', requirePolicy({ policy: 'wilson.manage' }), bodyParserMiddleware(['json']), async ctx => {
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
 * from [board.ck](../../data/contracts/board.ck) `POST /api/cards/{id}/plan/close`
 */
BoardRouter.post('/api/cards/:id/plan/close', requirePolicy({ policy: 'wilson.manage' }), async ctx => {
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
 * from [board.ck](../../data/contracts/board.ck) `POST /api/cards/{id}/plan/turn`
 */
BoardRouter.post('/api/cards/:id/plan/turn', requirePolicy({ policy: 'wilson.manage' }), bodyParserMiddleware(['json']), async ctx => {
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
 * from [board.ck](../../data/contracts/board.ck) `POST /api/cards/{id}/plan/comments`
 */
BoardRouter.post('/api/cards/:id/plan/comments', requirePolicy({ policy: 'wilson.manage' }), bodyParserMiddleware(['json']), async ctx => {
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
 * from [board.ck](../../data/contracts/board.ck) `GET /api/cards/{id}/plan/comments`
 */
BoardRouter.get('/api/cards/:id/plan/comments', requirePolicy({ policy: 'wilson.view' }), async ctx => {
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
 * from [board.ck](../../data/contracts/board.ck) `POST /api/cards/{id}/plan/comments/{commentId}/resolve`
 */
BoardRouter.post('/api/cards/:id/plan/comments/:commentId/resolve', requirePolicy({ policy: 'wilson.manage' }), async ctx => {
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
 * from [board.ck](../../data/contracts/board.ck) `GET /api/cards/{id}/events`
 */
BoardRouter.get('/api/cards/:id/events', requirePolicy({ policy: 'wilson.view' }), async ctx => {
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
 * Card 0263. Read-only, like `division`/`lint` above: nothing here recomputes or stores anything,
 * it only sums what `EventLog` already has. A card with no `stage.passed`/`stage.failed` events on
 * record gets zeros and an empty `stages` list, in a 200 — that is an ordinary card that has not
 * run yet, not the same fact as "no such card", which stays the 404 every other operation on this
 * surface gives.
 * from [board.ck](../../data/contracts/board.ck) `GET /api/cards/{id}/usage`
 */
BoardRouter.get('/api/cards/:id/usage', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const { id } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
        }),
    );

    const service = ctx.container.get(BoardService);
    const result: CardUsage = await service.usage(id);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * Card 0265. The one thing `ready`'s human gate could not do without a terminal: read the code a
 * card actually changed. `merge-base(main, branch)..branch`, the same range `wilson card diff`
 * already uses (this card's Constraints) — never `main..branch`, which would report every file
 * `main` gained since the fork as a deletion this card never made. Nothing here cuts, resumes or
 * reclaims a worktree; the branch's own history in `codeRoot`'s object database is enough to answer
 * this, so the endpoint still answers for a card whose worktree was already reclaimed.
 * from [board.ck](../../data/contracts/board.ck) `GET /api/cards/{id}/diff`
 */
BoardRouter.get('/api/cards/:id/diff', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const { id } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
        }),
    );

    const service = ctx.container.get(BoardService);
    const result: CardDiff = await service.diff(id);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * Card 0266. Turns a human's line comments on the Diff tab into the same kind of kickback a failed
 * review already produces: folds every comment into the card's `## Review findings` section
 * (`withFindings`, marked as human-written so implementing can tell the two apart) and moves the
 * card to `ready`'s own configured `onFail` — read from the live stage config, never hard-coded to
 * `implementing`, so a board that points `ready.onFail` elsewhere still routes correctly with no
 * code change. Not a runner kickback: `retries` is left untouched (this is not a stage failing, it
 * is a human's review) and the event's `by` is `'human'`, the same convention `move` uses for an
 * operator-initiated transition.
 * from [board.ck](../../data/contracts/board.ck) `POST /api/cards/{id}/findings`
 */
BoardRouter.post('/api/cards/:id/findings', requirePolicy({ policy: 'wilson.manage' }), bodyParserMiddleware(['json']), async ctx => {
    const { id } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
        }),
    );

    const body = await parseAndValidate(ctx.parsedBody, RecordFindingsRequest);

    const service = ctx.container.get(BoardWriteService);
    const result: CardDetail = await service.recordFindings(id, body);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [board.ck](../../data/contracts/board.ck) `GET /api/cards/{id}/versions`
 */
BoardRouter.get('/api/cards/:id/versions', requirePolicy({ policy: 'wilson.view' }), async ctx => {
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
 * from [board.ck](../../data/contracts/board.ck) `GET /api/stages`
 */
BoardRouter.get('/api/stages', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const service = ctx.container.get(StagesService);
    const result: BoardColumns = await service.columns();

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * Gives the project a stage config an operator can start a card against immediately — a
 * `wilson.stage_configs` row holding the default document. This used to scaffold the sibling board
 * repo (cards/, config/stages.yaml, context/, a git repo); the board is Postgres now, stage config
 * included, so the row is all there is to initialise, and no path is involved.
 * from [board.ck](../../data/contracts/board.ck) `POST /api/board/init`
 */
BoardRouter.post('/api/board/init', requirePolicy({ policy: 'wilson.manage' }), async ctx => {
    const service = ctx.container.get(BoardBootstrapService);
    const result: BoardColumns = await service.init();

    ctx.status = 201;
    ctx.type = 'application/json';
    ctx.body = result;
});
