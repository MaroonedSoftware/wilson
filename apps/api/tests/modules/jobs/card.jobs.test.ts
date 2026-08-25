import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { CardJobs } from '#modules/jobs/card.jobs.js';
import { PostgresBoardRepository } from '#modules/board/postgres.board.repository.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';
import type { JobBroker } from '@maroonedsoftware/jobbroker';
import type { EventLog } from '#modules/events/event.log.js';
import type { Kysely } from 'kysely';
import type { DB } from '#modules/data/db.js';

let db: Kysely<DB>;
beforeAll(async () => {
    db = testDb();
    // `confirmInFlightAfterStop` (card 0098) reads pg-boss's own job table directly, over the
    // application's connection, rather than through the broker. A real pg-boss install creates this
    // schema itself (`plans.js`'s `createTableJob`, `pgboss.job`) the first time it starts; nothing
    // in this test suite ever boots a real `PgBoss`, so the minimal shape those tests depend on —
    // the `id` and `state` columns `confirmInFlightAfterStop`'s query actually reads — is created
    // here instead. `IF NOT EXISTS` makes this safe to run every time the suite does.
    await sql`create schema if not exists pgboss`.execute(db);
    await sql`create table if not exists pgboss.job (id uuid primary key, state text not null)`.execute(db);
});
afterAll(async () => {
    await db.destroy();
});

/**
 * Card 0030. The stored row is a claim, not an answer: it records which job was last enqueued for a
 * card, and the broker's view of that job decides whether the card is actually in flight.
 *
 * That distinction is the whole design. It is what lets one mechanism answer three questions —
 * should `card start` refuse, may a poller enqueue, and is a stage abandoned — without a separate
 * reconciliation sweep, because a claim whose job has settled is retired the first time anything
 * asks.
 */
describe('CardJobs', () => {
    let cardJobs: CardJobs;
    let getJob: ReturnType<typeof vi.fn>;
    let config: StaticBoardConfig;

    beforeEach(async () => {
        config = new StaticBoardConfig(uniqueProject(), '/tmp/board', '/tmp/code', '/tmp/wt', '/tmp/run');
        // A card row has to exist: card_jobs is keyed to it, so a claim cannot outlive its card.
        const board = new PostgresBoardRepository(config, db, { append: async () => {} } as unknown as EventLog);
        await board.create(
            { frontmatter: { id: '0001', title: 'a card', stage: 'implementing', dependsOn: [], retries: {} }, sections: {}, body: 'x\n' },
            'create',
        );

        getJob = vi.fn();
        cardJobs = new CardJobs(config, db, { getJob } as unknown as JobBroker);
    });

    it('reports nothing in flight for a card that has never been enqueued', async () => {
        expect(await cardJobs.inFlight('0001')).toBeUndefined();
        expect(getJob).not.toHaveBeenCalled();
    });

    it.each(['created', 'retry', 'active'])('reports the job while it is %s', async state => {
        await cardJobs.record('0001', 'job-1');
        getJob.mockResolvedValue({ id: 'job-1', name: 'card.stage', state, data: {} });

        expect(await cardJobs.inFlight('0001')).toBe('job-1');
    });

    it.each(['completed', 'failed', 'cancelled'])('reports nothing once the job is %s, and retires the claim', async state => {
        await cardJobs.record('0001', 'job-1');
        getJob.mockResolvedValue({ id: 'job-1', name: 'card.stage', state, data: {} });

        expect(await cardJobs.inFlight('0001')).toBeUndefined();

        // Retired, not merely ignored: the next call must not need the broker to reach the same answer.
        getJob.mockClear();
        expect(await cardJobs.inFlight('0001')).toBeUndefined();
        expect(getJob).not.toHaveBeenCalled();
    });

    /**
     * A job the broker cannot find is settled too. The queue may have been reset or the job deleted;
     * either way nothing is running, and treating "unknown" as in flight would strand the card
     * forever behind a claim nothing can ever release.
     */
    it('reports nothing when the broker has no record of the job at all', async () => {
        await cardJobs.record('0001', 'job-gone');
        getJob.mockResolvedValue(null);

        expect(await cardJobs.inFlight('0001')).toBeUndefined();
    });

    it('replaces the claim rather than accumulating one row per enqueue', async () => {
        await cardJobs.record('0001', 'job-1');
        await cardJobs.record('0001', 'job-2');
        getJob.mockResolvedValue({ id: 'job-2', name: 'card.stage', state: 'active', data: {} });

        expect(await cardJobs.inFlight('0001')).toBe('job-2');
        const rows = await db.selectFrom('runner.cardJobs').selectAll().where('project', '=', config.project).execute();
        expect(rows).toHaveLength(1);
    });

    it('clears a claim that is still live, for a caller that knows better than the broker', async () => {
        await cardJobs.record('0001', 'job-1');
        await cardJobs.clear('0001');
        expect(await cardJobs.inFlight('0001')).toBeUndefined();
    });

    it('does not fail when clearing a card that holds no claim', async () => {
        await expect(cardJobs.clear('0001')).resolves.toBeUndefined();
    });
});

/**
 * Card 0098: `stopCardStageJobs` used to ask this same question via `inFlight` after `runner.stop()`
 * had already closed pg-boss's connection — `broker.getJob` throwing `Manager.assertDb`'s "Database
 * connection is not opened". `confirmInFlightAfterStop` exists to be askable at that exact moment, by
 * reading `pgboss.job` directly over `this.db` (the application's own, separate connection) instead
 * of going through the broker at all.
 *
 * These tests never touch the fake `getJob` the way `CardJobs`'s other describe block does — that is
 * the point. Asserting `getJob` was never called is what proves this method really does not depend on
 * the broker, not merely that it happens to return the right answer in these fakes.
 */
describe('CardJobs.confirmInFlightAfterStop', () => {
    let cardJobs: CardJobs;
    let getJob: ReturnType<typeof vi.fn>;
    let config: StaticBoardConfig;
    const cardId = '0001';

    beforeEach(async () => {
        config = new StaticBoardConfig(uniqueProject(), '/tmp/board', '/tmp/code', '/tmp/wt', '/tmp/run');
        const board = new PostgresBoardRepository(config, db, { append: async () => {} } as unknown as EventLog);
        await board.create(
            { frontmatter: { id: cardId, title: 'a card', stage: 'implementing', dependsOn: [], retries: {} }, sections: {}, body: 'x\n' },
            'create',
        );

        getJob = vi.fn();
        cardJobs = new CardJobs(config, db, { getJob } as unknown as JobBroker);
    });

    const insertPgBossJob = async (jobId: string, state: string): Promise<void> => {
        await sql`insert into pgboss.job (id, state) values (${jobId}::uuid, ${state})`.execute(db);
    };

    it('reports nothing for a card that has never been enqueued, without calling the broker', async () => {
        expect(await cardJobs.confirmInFlightAfterStop(cardId)).toBeUndefined();
        expect(getJob).not.toHaveBeenCalled();
    });

    it.each(['created', 'retry', 'active'])('reports the job while pgboss.job shows it %s, without calling the broker', async state => {
        const jobId = randomUUID();
        await cardJobs.record(cardId, jobId);
        await insertPgBossJob(jobId, state);

        expect(await cardJobs.confirmInFlightAfterStop(cardId)).toBe(jobId);
        expect(getJob).not.toHaveBeenCalled();
    });

    it.each(['completed', 'failed', 'cancelled'])('reports nothing once pgboss.job shows %s, and retires the claim', async state => {
        const jobId = randomUUID();
        await cardJobs.record(cardId, jobId);
        await insertPgBossJob(jobId, state);

        expect(await cardJobs.confirmInFlightAfterStop(cardId)).toBeUndefined();

        // Retired, not merely ignored: the next call must not need pgboss.job to reach the same answer.
        const rows = await db.selectFrom('runner.cardJobs').selectAll().where('project', '=', config.project).where('cardId', '=', cardId).execute();
        expect(rows).toHaveLength(0);
    });

    /**
     * A job pgboss.job has no row for at all is settled too, the same reasoning `inFlight` applies
     * for a broker that cannot find the job: the queue may have been reset or the job deleted, and
     * either way nothing is running.
     */
    it('reports nothing when pgboss.job has no row for the claimed job id at all, and retires the claim', async () => {
        const jobId = randomUUID();
        await cardJobs.record(cardId, jobId);

        expect(await cardJobs.confirmInFlightAfterStop(cardId)).toBeUndefined();

        const rows = await db.selectFrom('runner.cardJobs').selectAll().where('project', '=', config.project).where('cardId', '=', cardId).execute();
        expect(rows).toHaveLength(0);
    });

    /**
     * Card 0098's constraint: a read that fails outright is not "the card settled" and must not be
     * reported as if it were — `stopCardStageJobs` is what turns an unanswerable question into the
     * report's `unconfirmed` state, and it can only do that if this rejects instead of resolving.
     * `pgboss.job.id` is `uuid`; a claimed job id that never was one (never possible from a real
     * broker, but exactly the shape "the read fails" takes here) makes Postgres itself refuse the
     * query rather than this method interpreting the failure as an answer.
     */
    it('propagates a failed read rather than treating it as settled', async () => {
        await cardJobs.record(cardId, 'not-a-valid-uuid');

        await expect(cardJobs.confirmInFlightAfterStop(cardId)).rejects.toThrow();
    });
});
