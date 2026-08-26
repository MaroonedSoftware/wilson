import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import type { PoolClient } from 'pg';
import type { Logger } from '@maroonedsoftware/logger';
import { KyselyPool } from '@maroonedsoftware/kysely';
import { EventLog } from '#modules/events/event.log.js';
import { CARD_FEED_CHANNEL } from '#modules/feed/card.feed.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';
import type { DB } from '#modules/data/db.js';

const silentLogger: Logger = {
    error: () => undefined,
    warn: () => undefined,
    info: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
};

/**
 * `EventLog.append` publishes with `pg_notify`, real Postgres behaviour that no mock can stand
 * in for: a `NOTIFY` issued inside an open transaction is queued and only delivered once that
 * transaction commits, and is discarded outright on rollback. These tests listen on the real
 * channel with a second, independent connection — the same way `card.feed.listener.ts` does in
 * production — and assert on what that listener actually receives: identity, not the event's
 * `payload` — see the comment above `EventLog.append`'s `pg_notify` call.
 */
describe('EventLog.append publishing', () => {
    let db: Kysely<DB>;
    let listenPool: KyselyPool;
    let listenClient: PoolClient;
    let notifications: Array<Record<string, unknown>>;

    beforeAll(async () => {
        db = testDb();
        listenPool = new KyselyPool({
            host: process.env.TEST_DATABASE_HOST ?? 'localhost',
            port: Number(process.env.TEST_DATABASE_PORT ?? 15533),
            user: process.env.TEST_DATABASE_USER ?? 'postgres',
            password: process.env.TEST_DATABASE_PASSWORD ?? 'postgres',
            database: process.env.TEST_DATABASE_NAME ?? 'wilson_test',
        });
        listenClient = await listenPool.connect();
        listenClient.on('notification', message => {
            if (message.channel === CARD_FEED_CHANNEL && message.payload) {
                notifications.push(JSON.parse(message.payload) as Record<string, unknown>);
            }
        });
        await listenClient.query(`LISTEN ${CARD_FEED_CHANNEL}`);
    });

    beforeEach(() => {
        notifications = [];
    });

    afterAll(async () => {
        listenClient.release(true);
        await listenPool.end();
        await db.destroy();
    });

    const waitFor = async (predicate: () => boolean, timeoutMs = 2000): Promise<void> => {
        const start = Date.now();
        while (!predicate()) {
            if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for a notification');
            await new Promise(resolve => setTimeout(resolve, 20));
        }
    };

    it('notifies the card feed channel as soon as a standalone event is appended, with identity but not payload', async () => {
        const project = uniqueProject();
        const cardId = '0001';
        const eventLog = new EventLog(db, silentLogger);

        await eventLog.append({ project, cardId, stage: 'implementing', type: 'stage.dispatched', payload: { attempt: 1 } });

        await waitFor(() => notifications.some(n => n.project === project));
        const notification = notifications.find(n => n.project === project);
        const row = await db
            .selectFrom('runner.cardEvents')
            .where('project', '=', project)
            .where('cardId', '=', cardId)
            .selectAll()
            .executeTakeFirstOrThrow();
        expect(notification).toStrictEqual({
            project,
            cardId,
            stage: 'implementing',
            type: 'stage.dispatched',
            id: String(row.id),
        });
    });

    /**
     * The property the plan calls out explicitly: publishing must happen after the transaction
     * commits, not inside it, "or a rolled-back transition will have been broadcast as though it
     * happened". Postgres itself discards a queued `NOTIFY` on rollback as long as it was issued
     * on the same connection/transaction as the insert — which is exactly what this proves, from
     * the subscriber's side rather than by reading the implementation.
     */
    it('never notifies for an event appended inside a transaction that rolls back', async () => {
        const project = uniqueProject();
        const cardId = '0002';
        const eventLog = new EventLog(db, silentLogger);

        await expect(
            db.transaction().execute(async trx => {
                await eventLog.append({ project, cardId, stage: 'implementing', type: 'stage.dispatched' }, trx);
                throw new Error('boom');
            }),
        ).rejects.toThrow('boom');

        // Give a wrongly-scoped publish (e.g. one that notifies on the pool instead of the open
        // transaction) time to have arrived, before asserting the negative.
        await new Promise(resolve => setTimeout(resolve, 300));
        expect(notifications.some(n => n.project === project)).toBe(false);

        // And the row itself never survived either — confirming this was a real rollback, not a
        // race in the test.
        const rows = await db
            .selectFrom('runner.cardEvents')
            .where('project', '=', project)
            .where('cardId', '=', cardId)
            .selectAll()
            .execute();
        expect(rows).toHaveLength(0);
    });

    it('notifies once a transactional append commits, carrying the same identity the row records', async () => {
        const project = uniqueProject();
        const cardId = '0003';
        const eventLog = new EventLog(db, silentLogger);

        await db.transaction().execute(async trx => {
            await eventLog.append({ project, cardId, stage: 'review', type: 'transition.written', payload: { by: 'agent' } }, trx);
        });

        await waitFor(() => notifications.some(n => n.project === project));
        const notification = notifications.find(n => n.project === project);
        const row = await db
            .selectFrom('runner.cardEvents')
            .where('project', '=', project)
            .where('cardId', '=', cardId)
            .selectAll()
            .executeTakeFirstOrThrow();
        expect(notification).toStrictEqual({
            project,
            cardId,
            stage: 'review',
            type: 'transition.written',
            id: String(row.id),
        });
    });

    /**
     * The case that used to be impossible: `EventLog.append` no longer puts the payload on the
     * NOTIFY channel at all, so a payload well past Postgres's 8000-byte NOTIFY cap can neither
     * fail the append nor even shrink the notification — the notification is exactly as small as
     * any other event's, because it never carried `payload` to begin with. The row still gets the
     * whole thing, since `JSONB` has no such limit; `card.feed.listener.test.ts` covers the
     * subscriber's side of reading it back.
     */
    it('appends and notifies successfully for a payload well past the old 8000-byte NOTIFY limit', async () => {
        const project = uniqueProject();
        const cardId = '0004';
        const eventLog = new EventLog(db, silentLogger);
        const bigPayload = { result: 'x'.repeat(20000) };

        await eventLog.append({ project, cardId, stage: 'implementing', type: 'stage.passed', payload: bigPayload });

        await waitFor(() => notifications.some(n => n.project === project));
        const notification = notifications.find(n => n.project === project);
        expect(notification).not.toHaveProperty('payload');

        const row = await db
            .selectFrom('runner.cardEvents')
            .where('project', '=', project)
            .where('cardId', '=', cardId)
            .selectAll()
            .executeTakeFirstOrThrow();
        expect(row.payload).toEqual(bigPayload);
        expect(notification).toStrictEqual({
            project,
            cardId,
            stage: 'implementing',
            type: 'stage.passed',
            id: String(row.id),
        });
    });

    /**
     * The boundary the plan calls out explicitly: "a failed publish must never fail an append."
     * Dropping `payload` from the envelope fixes the common case, but the envelope can still blow
     * through Postgres's 8000-byte NOTIFY cap on its own if a caller-controlled field like
     * `project` is big enough — proving the `try`/`catch` around the `pg_notify` call holds for
     * more than just the case it was written for. The row must still land and `append` must still
     * resolve, with the failure surfaced through the logger instead of thrown.
     */
    it('still appends the row and resolves, logging instead of throwing, when the notify envelope itself is too large to publish', async () => {
        const project = `${uniqueProject()}-${'x'.repeat(8100)}`;
        const cardId = '0005';
        const errors: unknown[] = [];
        const spyLogger: Logger = { ...silentLogger, error: err => errors.push(err) };
        const eventLog = new EventLog(db, spyLogger);

        await expect(
            eventLog.append({ project, cardId, stage: 'implementing', type: 'stage.dispatched', payload: {} }),
        ).resolves.toBeUndefined();

        const row = await db
            .selectFrom('runner.cardEvents')
            .where('project', '=', project)
            .where('cardId', '=', cardId)
            .selectAll()
            .executeTakeFirstOrThrow();
        expect(row.type).toBe('stage.dispatched');
        expect(errors).toHaveLength(1);

        // The publish itself is what failed, so nothing should have reached the channel.
        await new Promise(resolve => setTimeout(resolve, 300));
        expect(notifications.some(n => n.project === project)).toBe(false);
    });
});
