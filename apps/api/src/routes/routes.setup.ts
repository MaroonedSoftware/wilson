import { Kysely } from 'kysely';
import { httpError } from '@maroonedsoftware/errors';
import { openSseStream, resolveLastEventId, ServerKitRouter, type SseContext } from '@maroonedsoftware/koa';
import { BoardConfig } from '#modules/board/board.config.js';
import { runAsProject } from '#modules/board/project.context.js';
import { ProjectRepository } from '#modules/board/project.repository.js';
import type { DB } from '#modules/data/db.js';
import { cardFeed } from '#modules/feed/card.feed.js';
import { openCardFeedStream } from '#modules/feed/card.feed.route.js';
import { toGeneratedTurn } from '#modules/plan/plan.service.js';
import { planFeed } from '#modules/plan/plan.session.feed.js';
import { PlanTurnRepository } from '#modules/plan/plan.turn.repository.js';
import { BoardRouter } from './board.router.js';
import { HealthRouter } from './health.router.js';
import { SettingsRouter } from './settings.router.js';

/**
 * Card 0150. The request header a caller names a project with — see this file's own
 * `ProjectContextRouter` for what reads it and `packages/sdk/src/sdk-options.ts` /
 * `packages/cli/src/api-client.ts` for the two callers that send it. Not shared as an importable
 * constant across the `apps/api`/`packages/sdk`/`packages/cli` boundary: there is no package the
 * three already depend on to hold it (mirroring `DEFAULT_PORT`'s duplicated-literal precedent in
 * `packages/cli/src/api-client.ts`), so the string is repeated at each end with a comment pointing
 * at the others instead.
 */
const PROJECT_HEADER = 'x-wilson-project';

/**
 * Card 0150. Every HTTP request runs inside `runAsProject` for whichever project it named (or the
 * daemon's own configured one, if it named none) — the one entry point card 0149's ambient context
 * left unset, per that card's own doc comment in `project.context.ts`.
 *
 * A `.use()`-only router with no routes of its own, mounted first in {@link routers} below, rather
 * than added to `HealthRouter`/`BoardRouter`/`SettingsRouter`/`FeedRouter`/`PlanStreamRouter`
 * individually: `setupRoutes` (`ServerKitServerBuilder`'s own doc comment) mounts each router's
 * `.routes()` as a separate `app.use()`, in array order, and `@koa/router`'s `.use()` middleware
 * matches every path and always falls through to the outer `next` when nothing on this router
 * handles the response — which here is every request, since this router registers no `.get`/`.post`
 * of its own. That outer `next` is exactly the next router in the array, so this runs ahead of all
 * five without touching any of them, keeping `board.ck`, `settings.ck`,
 * `apps/api/src/generated/**` and `board.router.ts` exactly as they are (this card's own
 * constraint) and keeping the two SSE routers' project scoping (see both below) inside the same
 * `runAsProject` every JSON route gets.
 *
 * `ctx.container` (not a constructor argument) is where `BoardConfig`/`ProjectRepository` come
 * from — the same per-request resolution `PlanStreamRouter` below already uses `BoardConfig` for —
 * because {@link routers} builds every router before the container exists (`setup.server.ts` calls
 * it during `serverBuilder.setupRoutes`, which itself runs before `start`); only a request handler,
 * invoked once the server is live, has a container to resolve from.
 *
 * A header naming a project with no `runner.projects` row is refused with the server's own
 * sentence (`httpError(400)`, matching every other validation failure's shape — see
 * `board.write.service.ts`) before `runAsProject` ever opens a scope for it, so nothing downstream
 * — a board read, a board write, an SSE stream — ever runs against, or leaks from, a project that
 * was never real. Checked against `ProjectRepository.find` (Postgres), not `BoardConfig`'s own
 * in-memory registration map: that map is only ever as fresh as the last boot or poller tick (see
 * `board.module.ts`'s and `poller.ts`'s own doc comments on that lag), and a project added by hand
 * between ticks — or with the poller disabled entirely — must still be usable the moment its row
 * exists, not after this process happens to notice it. `board.register(row)` folds the fresh row
 * into that map regardless, the same idempotent call `Poller.tick` makes every tick, so a later
 * request (or a job) sees it without a DB round trip.
 *
 * No header at all resolves to `board.project` — `ProjectScopedBoardConfig`'s own fallback to the
 * daemon's configured project when nothing has called `runAsProject` yet (`board.config.ts`) — and
 * is never checked against Postgres: that project was already registered eagerly at boot
 * (`BoardModule.setup`), so every existing caller (the CLI, the app, `curl`) keeps working exactly
 * as it does today, with no new failure mode and no new request cost.
 */
const ProjectContextRouter = () => {
    const router = ServerKitRouter();
    router.use(async (ctx, next) => {
        const board = ctx.container.get(BoardConfig);
        const header = ctx.get(PROJECT_HEADER);
        const project = header || board.project;

        if (header) {
            const row = await ctx.container.get(ProjectRepository).find(header);
            if (!row) throw httpError(400).withDetails({ reason: `project "${header}" is not registered` });
            board.register(row);
        }

        await runAsProject(project, next);
    });
    return router;
};

/**
 * Builds the live card feed router: current stage and latest event per card, over SSE at
 * `/api/feed`.
 *
 * Not `@maroonedsoftware/koa/serverfeed`'s `serverFeedRouter`: it guards its route with
 * `requirePolicy`, defaulting to an MFA gate, and even `{ policy: false }` still requires a valid
 * session per its own doc comment. This server has no authentication and no sessions at all (card
 * 0019), so no policy option that factory offers is satisfiable here. `openCardFeedStream` (see
 * `modules/feed/card.feed.route.ts`) takes the response over directly instead, the same way
 * `serverfeed`'s lower-level `handleServerFeed` does, and imposes no policy.
 *
 * A factory rather than a module-level constant, unlike the other routers here: it needs the
 * server's lifecycle signal (`ServerKitServerBuilder.lifecycleSignal`) so shutdown drains an open
 * stream instead of holding the socket until the force-close grace period, and that signal only
 * exists once `setupServer` has constructed the builder — not at this module's import time.
 * `signal` is optional so a caller with no server lifecycle (a test) still gets a working router.
 *
 * Card 0150: `ctx.container.get(BoardConfig).project` is read inside the handler, after
 * `ProjectContextRouter` has already run (see that router's own doc comment on mount order) and
 * opened this request's `runAsProject` scope — so it is whichever project the request named, or the
 * daemon's own configured one if it named none, never the wrong project and never a project that
 * failed the registration check. Threaded into `openCardFeedStream` so this stream only ever
 * carries that one project's card events (see that function's own doc comment on why), which is
 * this card's answer to "what does a stream do when its project is absent or unregistered": absent
 * means the daemon's configured project, same as any other route, and unregistered never reaches
 * here at all — `ProjectContextRouter` already refused the request before this handler runs.
 */
export const FeedRouter = (signal?: AbortSignal) => {
    const router = ServerKitRouter();
    router.get('/api/feed', async ctx => {
        openCardFeedStream(ctx as unknown as SseContext, cardFeed, signal, ctx.container.get(BoardConfig).project);
    });
    return router;
};

/**
 * Card 0133's other SSE stream: a card's planning conversation, over `/api/cards/:id/plan/stream`.
 * Built by hand beside `FeedRouter`, for exactly the reason `FeedRouter`'s own doc comment gives —
 * ContractKit emits JSON handlers, and there is no JSON handler to generate for a response that
 * never resolves — and `board.ck`'s `POST .../plan/turn` operation says so explicitly rather than
 * leaving this stream undocumented.
 *
 * Replays every stored turn after the client's `Last-Event-ID` (`0` for a fresh connection, so
 * every turn) before subscribing to `planFeed` for the assistant text still being written for the
 * turn in flight, if any — `runner.plan_turns` is a card's history, and `planFeed` is only ever the
 * deltas of the one turn a live session happens to be producing right now, so a client is caught up
 * on both without a gap between them.
 *
 * Not `openCardFeedStream`/`cardFeed`: that stream serves latest-per-card snapshot and deliberately
 * does not replay (its own doc comment), and a transcript is exactly the history it declines to
 * serve. Built on `openSseStream` directly instead, the same transport primitive, composed for
 * replay-then-subscribe rather than snapshot-then-subscribe.
 *
 * `PlanTurnRepository` is constructed here rather than resolved through `ctx.container`: it carries
 * no DI registration of its own (see its class doc comment), the same reason `PlanService` builds
 * one itself from the same two dependencies, both of which the container already has.
 *
 * Takes the server's lifecycle signal, same as `FeedRouter`, so shutdown drains an open plan stream
 * instead of holding its socket to the force-close grace period.
 *
 * Card 0150: `board` below is read once the request's `runAsProject` scope is already open (see
 * `ProjectContextRouter`'s mount-order doc comment), so `board.project` is the project this stream
 * was opened for. `planTurns.since` needs no change for it — `PlanTurnRepository` already scopes
 * every query to `this.config.project` (its own file), which is this same `BoardConfig`. The live
 * `planFeed` subscription below is different: unlike the turn history, it was filtered by
 * `correlationId` alone, and `PlanService.query` (`plan.service.ts`) publishes deltas keyed by
 * `${boardConfig.project}:${cardId}`, the same `source`/`correlationId` pairing `card.feed.ts`
 * documents — so two projects' cards sharing an id would otherwise cross-deliver a live turn in
 * progress. Adding `source: board.project` here closes that without touching `plan.session.feed.ts`
 * or `plan.service.ts`, both outside this card's files in scope.
 */
export const PlanStreamRouter = (signal?: AbortSignal) => {
    const router = ServerKitRouter();
    router.get('/api/cards/:id/plan/stream', async ctx => {
        const id = String(ctx.params.id);
        const headerId = ctx.headers['last-event-id'];
        const lastEventId = resolveLastEventId(typeof headerId === 'string' ? headerId : '', ctx.query.lastEventId);

        const board = ctx.container.get(BoardConfig);
        const planTurns = new PlanTurnRepository(board, ctx.container.get(Kysely<DB>));
        const stream = openSseStream(ctx as unknown as SseContext, { signal });

        const missed = await planTurns.since(id, lastEventId);
        for (const turn of missed) {
            stream.event({ id: turn.seq, event: 'turn', data: toGeneratedTurn(turn) });
        }

        stream.onClose(
            planFeed.onEvent({ correlationId: id, source: board.project }, event => stream.event({ event: 'delta', data: event.message })),
        );
    });
    return router;
};

/**
 * Every router the server mounts, in one place — adding a router later is one line here.
 *
 * The `*.router.ts` files beside this one are generated from `data/contracts/*.ck` and must not be
 * edited; regenerate with `pnpm codegen`. This file is the only hand-written thing in the directory.
 *
 * Every route is generated, with two deliberate exceptions: `FeedRouter` and `PlanStreamRouter`
 * above. Card 0019 wrote the health route by hand and said why that was temporary — the health and
 * board routes are generated now, so that rule holds. An SSE stream is different in kind, not just
 * unfinished codegen: ContractKit emits JSON handlers, and there is no JSON handler to generate for
 * a response that never resolves. Both routers are built here, in this hand-written file, rather
 * than as new files beside it, so the "every file here but this one is generated" invariant the
 * tests enforce stays true. `ProjectContextRouter`, also above, is a third hand-written entry, but
 * not a route: it carries no `.get`/`.post` of its own, and that invariant is about generated
 * *files*, not about every router in this array being a wrapper around ContractKit output.
 *
 * `ProjectContextRouter` is listed first, deliberately: see its own doc comment for why array order
 * is exactly what makes it run ahead of the other five without being merged into any of them.
 *
 * Takes the server's lifecycle signal and threads it to both SSE routers; the other three routers
 * have no long-lived connection to drain and stay untouched by it.
 *
 * Left untyped as `ServerKitRouterType[]`: that type is the erased, invariant `Router<unknown,
 * unknown>`, so callers cast at the point they hand this to `setupRoutes` instead.
 */
export const routers = (signal?: AbortSignal) => [
    ProjectContextRouter(),
    HealthRouter,
    BoardRouter,
    SettingsRouter,
    FeedRouter(signal),
    PlanStreamRouter(signal),
];
