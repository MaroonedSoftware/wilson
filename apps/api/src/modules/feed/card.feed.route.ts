import { openSseStream, type SseContext } from '@maroonedsoftware/koa';
import type { ServerFeed } from '@maroonedsoftware/serverfeed';

/**
 * Serve one `/api/feed` subscriber: the latest known state of every card (`feed.snapshot()`) up
 * front, then every event as it is published.
 *
 * Deliberately not `@maroonedsoftware/koa/serverfeed`'s `handleServerFeed`: that helper replays
 * the buffered ring since the client's `Last-Event-ID`, which for a fresh connection — the only
 * case this route needs, since reconnection and `Last-Event-ID` resume are out of scope — means
 * replaying everything still buffered. That is exactly the "replay it has to fold" this feed
 * exists to avoid; a board wants current state, not history. `feed.snapshot()` gives the latest
 * event per card instead, so a subscriber is caught up in one shot with nothing to fold.
 *
 * `openSseStream` is the same transport primitive `handleServerFeed` is built on, so this is still
 * the library's mechanism, just composed for latest-per-key rather than replay.
 *
 * `signal`, when given, is the server's lifecycle signal: it drains this stream on shutdown
 * instead of leaving it to hold the socket open until the force-close grace period, and closing
 * the stream (for this reason as for any other) releases the `feed.onEvent` subscription below.
 * Optional so a caller with no server lifecycle — a test, or the CLI bootstrap, which skips
 * `start` hooks — still works exactly as before.
 *
 * Card 0150. `project`, when given, scopes both the initial snapshot and the live subscription to
 * that project's events (`ServerFeed`'s `source` filter — every event here is published with
 * `source` set to the project it happened in, see `card.feed.listener.ts`). Optional, and no-op
 * when omitted, so this stays exactly what it was for a single-project deployment: `FeedRouter`
 * (`routes.setup.ts`) passes the project its own project-context middleware already resolved for
 * the request, rather than every subscriber seeing every registered project's cards mixed together.
 */
export const openCardFeedStream = (ctx: SseContext, feed: ServerFeed, signal?: AbortSignal, project?: string): void => {
    const stream = openSseStream(ctx, { signal });
    const filter = project ? { source: project } : {};

    for (const event of feed.snapshot(filter)) {
        stream.event({ event: 'card', data: event });
    }

    stream.onClose(feed.onEvent(filter, event => stream.event({ event: 'card', data: event })));
};
