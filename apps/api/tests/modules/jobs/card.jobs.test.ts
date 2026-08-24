import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CardJobs } from '#modules/jobs/card.jobs.js';
import { PostgresBoardRepository } from '#modules/board/postgres.board.repository.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';
import type { JobBroker } from '@maroonedsoftware/jobbroker';
import type { EventLog } from '#modules/events/event.log.js';
import type { Kysely } from 'kysely';
import type { DB } from '#modules/data/db.js';

let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
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
