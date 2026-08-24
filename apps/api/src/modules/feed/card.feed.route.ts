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
 */
export const openCardFeedStream = (ctx: SseContext, feed: ServerFeed): void => {
    const stream = openSseStream(ctx);

    for (const event of feed.snapshot()) {
        stream.event({ event: 'card', data: event });
    }

    stream.onClose(feed.onEvent({}, event => stream.event({ event: 'card', data: event })));
};
