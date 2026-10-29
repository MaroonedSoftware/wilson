import type { PoolClient } from 'pg';
import type { KyselyPool } from '@maroonedsoftware/kysely';
import type { Logger } from '@maroonedsoftware/logger';
import { CARD_FEED_CHANNEL, cardFeed } from './card.feed.js';

/**
 * The shape `EventLog.append` notifies with: the event's identity, not its contents. See the
 * comment above its `pg_notify` call. `id` is the row's primary key in `runner.card_events`, kept
 * here so this listener can go fetch `payload` — the one field too large to risk putting on this
 * channel.
 */
interface CardFeedNotification {
    id: string;
    project: string;
    cardId: string;
    stage: string | null;
    type: string;
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
 *
 * `EventLog.append` notifies with the event's identity, not its contents — see the comment above
 * its `pg_notify` call. So on each notification this reads `payload` back off the row by `id` (one
 * extra round trip per event, via `pool` rather than the dedicated `client`, since the read is
 * unrelated to holding the LISTEN subscription) and forwards it alongside the identity the
 * notification already carried. A row that can't be read is logged and dropped, not thrown: a
 * subscriber-side failure here must never be mistaken for a reason to fail the append that already
 * committed.
 */
export const startCardFeedListener = async (pool: KyselyPool, logger: Logger, signal: AbortSignal): Promise<void> => {
    const client: PoolClient = await pool.connect();

    client.on('notification', message => {
        const raw = message.payload;
        if (message.channel !== CARD_FEED_CHANNEL || !raw) {
            return;
        }
        void (async (): Promise<void> => {
            try {
                const event = JSON.parse(raw) as CardFeedNotification;
                const { rows } = await pool.query<{ payload: Record<string, unknown> }>(`select payload from runner.card_events where id = $1`, [
                    event.id,
                ]);
                const row = rows[0];
                if (!row) {
                    logger.error(new Error(`card feed notification for missing card_events row ${event.id}`));
                    return;
                }
                cardFeed.status(event.project, event.cardId, event.type, { stage: event.stage, payload: row.payload });
            } catch (err) {
                logger.error(err);
            }
        })();
    });
    client.on('error', err => logger.error(err));

    await client.query(`LISTEN ${CARD_FEED_CHANNEL}`);

    signal.addEventListener('abort', () => client.release(true), { once: true });
};
