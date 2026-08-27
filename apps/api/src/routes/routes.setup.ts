import { Kysely } from 'kysely';
import { openSseStream, resolveLastEventId, ServerKitRouter, type SseContext } from '@maroonedsoftware/koa';
import { BoardConfig } from '#modules/board/board.config.js';
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
 */
export const FeedRouter = (signal?: AbortSignal) => {
    const router = ServerKitRouter();
    router.get('/api/feed', async ctx => {
        openCardFeedStream(ctx as unknown as SseContext, cardFeed, signal);
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
 */
export const PlanStreamRouter = (signal?: AbortSignal) => {
    const router = ServerKitRouter();
    router.get('/api/cards/:id/plan/stream', async ctx => {
        const id = String(ctx.params.id);
        const headerId = ctx.headers['last-event-id'];
        const lastEventId = resolveLastEventId(typeof headerId === 'string' ? headerId : '', ctx.query.lastEventId);

        const planTurns = new PlanTurnRepository(ctx.container.get(BoardConfig), ctx.container.get(Kysely<DB>));
        const stream = openSseStream(ctx as unknown as SseContext, { signal });

        const missed = await planTurns.since(id, lastEventId);
        for (const turn of missed) {
            stream.event({ id: turn.seq, event: 'turn', data: toGeneratedTurn(turn) });
        }

        stream.onClose(planFeed.onEvent({ correlationId: id }, event => stream.event({ event: 'delta', data: event.message })));
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
 * tests enforce stays true.
 *
 * Takes the server's lifecycle signal and threads it to both SSE routers; the other three routers
 * have no long-lived connection to drain and stay untouched by it.
 *
 * Left untyped as `ServerKitRouterType[]`: that type is the erased, invariant `Router<unknown,
 * unknown>`, so callers cast at the point they hand this to `setupRoutes` instead.
 */
export const routers = (signal?: AbortSignal) => [
    HealthRouter,
    BoardRouter,
    SettingsRouter,
    FeedRouter(signal),
    PlanStreamRouter(signal),
];
