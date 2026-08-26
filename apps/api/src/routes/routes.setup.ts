import { ServerKitRouter, type SseContext } from '@maroonedsoftware/koa';
import { cardFeed } from '#modules/feed/card.feed.js';
import { openCardFeedStream } from '#modules/feed/card.feed.route.js';
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
 * Every router the server mounts, in one place — adding a router later is one line here.
 *
 * The `*.router.ts` files beside this one are generated from `data/contracts/*.ck` and must not be
 * edited; regenerate with `pnpm codegen`. This file is the only hand-written thing in the directory.
 *
 * Every route is generated, with one deliberate exception: `FeedRouter` above. Card 0019 wrote the
 * health route by hand and said why that was temporary — the health and board routes are
 * generated now, so that rule holds. An SSE stream is different in kind, not just unfinished
 * codegen: ContractKit emits JSON handlers, and there is no JSON handler to generate for a
 * response that never resolves. `FeedRouter` is built here, in this hand-written file, rather than
 * as a new file beside it, so the "every file here but this one is generated" invariant the tests
 * enforce stays true.
 *
 * Takes the server's lifecycle signal and threads it to `FeedRouter` alone; the other three
 * routers have no long-lived connection to drain and stay untouched by it.
 *
 * Left untyped as `ServerKitRouterType[]`: that type is the erased, invariant `Router<unknown,
 * unknown>`, so callers cast at the point they hand this to `setupRoutes` instead.
 */
export const routers = (signal?: AbortSignal) => [HealthRouter, BoardRouter, SettingsRouter, FeedRouter(signal)];
