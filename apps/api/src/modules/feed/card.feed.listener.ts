import type { PoolClient } from 'pg';
import type { KyselyPool } from '@maroonedsoftware/kysely';
import type { Logger } from '@maroonedsoftware/logger';
import { CARD_FEED_CHANNEL, cardFeed } from './card.feed.js';

/** The shape `EventLog.append` notifies with — see its `pg_notify` call. */
interface CardFeedNotification {
    project: string;
    cardId: string;
    stage: string | null;
    type: string;
    payload: Record<string, unknown>;
}

/**
 * Bridges Postgres `NOTIFY` on {@link CARD_FEED_CHANNEL} into the in-process {@link cardFeed} bus.
 *
 * `EventLog.append` runs in every process that touches a card — this API server's own job runner,
 * and a separate `wilson` CLI invocation moving a card by hand — but `ServerFeed` is an in-process
 * bus (its own docs: not for "cross-process fan-out"). Postgres is the one thing every process
 * already shares, so `LISTEN`/`NOTIFY` is the bridge: whichever process appends an event notifies
 * this channel, and this server, listening on it, republishes onto `cardFeed` for its SSE
 * subscribers.
 *
 * Holds one connection checked out of `pool` for as long as `signal` stays unaborted. That
 * connection must never be returned to the pool afterwards — a later query borrowing it would run
 * against a connection still subscribed to `card_events` — so teardown discards it
 * (`client.release(true)`) instead of releasing it for reuse.
 */
export const startCardFeedListener = async (pool: KyselyPool, logger: Logger, signal: AbortSignal): Promise<void> => {
    const client: PoolClient = await pool.connect();

    client.on('notification', message => {
        if (message.channel !== CARD_FEED_CHANNEL || !message.payload) {
            return;
        }
        try {
            const event = JSON.parse(message.payload) as CardFeedNotification;
            cardFeed.status(event.project, event.cardId, event.type, { stage: event.stage, payload: event.payload });
        } catch (err) {
            logger.error(err);
        }
    });
    client.on('error', err => logger.error(err));

    await client.query(`LISTEN ${CARD_FEED_CHANNEL}`);

    signal.addEventListener('abort', () => client.release(true), { once: true });
};
