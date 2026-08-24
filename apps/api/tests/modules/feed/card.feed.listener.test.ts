import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import type { Logger } from '@maroonedsoftware/logger';
import { KyselyPool } from '@maroonedsoftware/kysely';
import { EventLog } from '#modules/events/event.log.js';
import { cardFeed } from '#modules/feed/card.feed.js';
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
        const eventLog = new EventLog(db);

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
     * The acceptance criterion in the plan's own words: "a client connecting after a transition
     * receives current state without replaying earlier events." This is what makes that possible
     * — the bridged event has to land in the feed's latest-per-key snapshot, not just fire past
     * any subscriber listening at that exact instant.
     */
    it('updates the feed snapshot for the card, so a late subscriber sees the transition without replay', async () => {
        const project = uniqueProject();
        const cardId = '0002';
        const eventLog = new EventLog(db);

        await eventLog.append({ project, cardId, stage: 'testing', type: 'transition.written', payload: {} });

        await waitFor(() => cardFeed.snapshot({ source: project, correlationId: cardId })[0]);

        const [snapshot] = cardFeed.snapshot({ source: project, correlationId: cardId });
        expect(snapshot).toMatchObject({ source: project, message: 'transition.written', data: { stage: 'testing' } });
    });
});
