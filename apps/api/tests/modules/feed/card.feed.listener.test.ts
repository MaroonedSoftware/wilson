import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, type Kysely } from 'kysely';
import type { Logger } from '@maroonedsoftware/logger';
import { KyselyPool } from '@maroonedsoftware/kysely';
import { EventLog } from '#modules/events/event.log.js';
import { CARD_FEED_CHANNEL, cardFeed } from '#modules/feed/card.feed.js';
import { startCardFeedListener } from '#modules/feed/card.feed.listener.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';
import type { DB } from '#modules/data/db.js';

const silentLogger: Logger = {
    error: () => undefined,
    warn: () => undefined,
    info: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
};

const waitFor = async <T>(get: () => T | undefined, timeoutMs = 3000): Promise<T> => {
    const start = Date.now();
    for (;;) {
        const value = get();
        if (value !== undefined) return value;
        if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for the bridged event');
        await new Promise(resolve => setTimeout(resolve, 20));
    }
};

/**
 * End to end, from a real `EventLog.append` through Postgres `NOTIFY`/`LISTEN` to the in-process
 * `cardFeed` bus — the whole reason `card.feed.listener.ts` exists: `EventLog.append` runs in
 * whatever process touched the card (this server, or a separate `wilson` CLI invocation), and
 * `ServerFeed` is in-process only, so Postgres is the bridge between them.
 */
describe('startCardFeedListener', () => {
    let db: Kysely<DB>;
    let pool: KyselyPool;
    let controller: AbortController;

    beforeAll(async () => {
        db = testDb();
        pool = new KyselyPool({
            host: process.env.TEST_DATABASE_HOST ?? 'localhost',
            port: Number(process.env.TEST_DATABASE_PORT ?? 15533),
            user: process.env.TEST_DATABASE_USER ?? 'postgres',
            password: process.env.TEST_DATABASE_PASSWORD ?? 'postgres',
            database: process.env.TEST_DATABASE_NAME ?? 'wilson_test',
        });
        controller = new AbortController();
        await startCardFeedListener(pool, silentLogger, controller.signal);
    });

    afterAll(async () => {
        controller.abort();
        await db.destroy();
        await pool.end();
    });

    it('republishes an appended event onto the card feed, as the type/stage/payload the route needs', async () => {
        const project = uniqueProject();
        const cardId = '0001';
        const eventLog = new EventLog(db, silentLogger);

        // Filtered by `source` (the project — unique per test call) as well as `correlationId`:
        // the underlying Postgres channel is shared by the whole test database, so another test
        // file's `NOTIFY` for the same plain card id must not be mistaken for this one.
        const seen = new Promise(resolve => {
            const unsubscribe = cardFeed.onEvent({ source: project, correlationId: cardId }, event => {
                unsubscribe();
                resolve(event);
            });
        });

        await eventLog.append({ project, cardId, stage: 'implementing', type: 'stage.dispatched', payload: { attempt: 1 } });

        const event = await Promise.race([
            seen,
            new Promise((_resolve, reject) => setTimeout(() => reject(new Error('bridged event never arrived')), 3000)),
        ]);

        expect(event).toMatchObject({
            source: project,
            correlationId: cardId,
            message: 'stage.dispatched',
            data: { stage: 'implementing', payload: { attempt: 1 } },
        });
    });

    /**
     * The case card 0105 hit: a `stage.passed` payload large enough to blow through Postgres's
     * 8000-byte NOTIFY cap. `EventLog.append` now puts only identity on the channel (see its
     * `pg_notify` call), and this listener reads the row back by id — so the bridged event carries
     * the payload in full, not the truncated stand-in the old stopgap produced.
     */
    it('carries a payload well past the old 8000-byte NOTIFY limit onto the card feed, in full', async () => {
        const project = uniqueProject();
        const cardId = '0003';
        const eventLog = new EventLog(db, silentLogger);
        const bigPayload = { result: 'x'.repeat(20000) };

        const seen = new Promise(resolve => {
            const unsubscribe = cardFeed.onEvent({ source: project, correlationId: cardId }, event => {
                unsubscribe();
                resolve(event);
            });
        });

        await eventLog.append({ project, cardId, stage: 'implementing', type: 'stage.passed', payload: bigPayload });

        const event = await Promise.race([
            seen,
            new Promise((_resolve, reject) => setTimeout(() => reject(new Error('bridged event never arrived')), 3000)),
        ]);

        expect(event).toMatchObject({
            source: project,
            correlationId: cardId,
            message: 'stage.passed',
            data: { stage: 'implementing', payload: bigPayload },
        });
    });

    /**
     * The acceptance criterion in the plan's own words: "a client connecting after a transition
     * receives current state without replaying earlier events." This is what makes that possible
     * — the bridged event has to land in the feed's latest-per-key snapshot, not just fire past
     * any subscriber listening at that exact instant.
     */
    it('updates the feed snapshot for the card, so a late subscriber sees the transition without replay', async () => {
        const project = uniqueProject();
        const cardId = '0002';
        const eventLog = new EventLog(db, silentLogger);

        await eventLog.append({ project, cardId, stage: 'testing', type: 'transition.written', payload: {} });

        await waitFor(() => cardFeed.snapshot({ source: project, correlationId: cardId })[0]);

        const [snapshot] = cardFeed.snapshot({ source: project, correlationId: cardId });
        expect(snapshot).toMatchObject({ source: project, message: 'transition.written', data: { stage: 'testing' } });
    });

    /**
     * The other half of the plan's boundary: "a subscriber that cannot read the row does not cause
     * the append to fail; the failure is logged." This drives a raw `NOTIFY` (bypassing
     * `EventLog.append`, which always notifies a real row) that names an `id` no row has, the same
     * shape the listener would see for a row deleted, or otherwise unreadable, between publish and
     * read. The listener must log the failure and must not publish anything to the feed for it —
     * and, since this uses the same shared connection every other test in this file relies on, it
     * must not take that connection down either.
     */
    it('logs and drops the notification, without publishing to the feed, when the notified row cannot be found', async () => {
        const project = uniqueProject();
        const cardId = '0004';
        const errors: unknown[] = [];
        const spyLogger: Logger = {
            error: err => errors.push(err),
            warn: () => undefined,
            info: () => undefined,
            debug: () => undefined,
            trace: () => undefined,
        };
        const spyController = new AbortController();
        await startCardFeedListener(pool, spyLogger, spyController.signal);

        try {
            await sql`select pg_notify(${CARD_FEED_CHANNEL}, ${JSON.stringify({
                project,
                cardId,
                stage: 'implementing',
                type: 'stage.dispatched',
                id: '999999999999',
            })})`.execute(db);

            await waitFor(() => (errors.length > 0 ? true : undefined));

            expect(errors).toHaveLength(1);
            expect(cardFeed.snapshot({ source: project, correlationId: cardId })).toHaveLength(0);
        } finally {
            spyController.abort();
        }
    });
});
