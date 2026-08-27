import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { PlanTurnRepository } from '#modules/plan/plan.turn.repository.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';
import type { DB } from '#modules/data/db.js';

let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

describe('PlanTurnRepository', () => {
    let repo: PlanTurnRepository;
    let config: StaticBoardConfig;

    beforeEach(() => {
        config = new StaticBoardConfig(uniqueProject(), '/tmp/board', '/tmp/code', '/tmp/wt', '/tmp/run');
        repo = new PlanTurnRepository(config, db);
    });

    it("assigns seq values that increase monotonically from a card's own start", async () => {
        const first = await repo.append('0001', 'user', 'hello');
        const second = await repo.append('0001', 'assistant', 'hi there');
        const third = await repo.append('0001', 'user', 'thanks');

        expect(first.seq).toBe(1);
        expect(second.seq).toBe(2);
        expect(third.seq).toBe(3);
    });

    it('does not share a seq counter between two different cards', async () => {
        await repo.append('0001', 'user', 'card one turn one');
        await repo.append('0001', 'user', 'card one turn two');

        const otherFirst = await repo.append('0002', 'user', 'card two turn one');

        // 0002 starts at its own beginning (1), unaffected by however far 0001 has gotten.
        expect(otherFirst.seq).toBe(1);
    });

    /**
     * The review finding on this card: a brand-new card has no row yet, so a naive `FOR UPDATE`
     * lock (which can only lock a row that already exists) cannot serialize the very first append.
     * Two concurrent first appends for the same new card must still land on distinct seq values
     * rather than colliding on seq 1 (which either throws a primary-key violation or silently loses
     * one turn), which is exactly the race `pg_advisory_xact_lock` was added to close.
     */
    it('assigns distinct seq values to two concurrent first appends for a brand-new card, never colliding on seq 1', async () => {
        const cardId = 'concurrent-first-turn';

        const [a, b] = await Promise.all([repo.append(cardId, 'user', 'race a'), repo.append(cardId, 'user', 'race b')]);

        expect([a.seq, b.seq].sort()).toEqual([1, 2]);
    });

    it('returns every turn strictly after an exclusive seq bound, and never the turn at that bound', async () => {
        await repo.append('0001', 'user', 'turn one');
        await repo.append('0001', 'assistant', 'turn two');
        await repo.append('0001', 'user', 'turn three');

        const afterOne = await repo.since('0001', 1);
        expect(afterOne.map(t => t.seq)).toEqual([2, 3]);
        expect(afterOne.some(t => t.seq === 1)).toBe(false);

        const afterZero = await repo.since('0001', 0);
        expect(afterZero.map(t => t.seq)).toEqual([1, 2, 3]);

        const afterAll3 = await repo.since('0001', 3);
        expect(afterAll3).toEqual([]);
    });

    it("reads a card's turns back in seq order, content and role intact", async () => {
        await repo.append('0001', 'user', 'what should I build?');
        await repo.append('0001', 'assistant', 'tell me more');
        await repo.append('0001', 'user', 'a widget');

        const turns = await repo.since('0001', 0);

        expect(turns.map(t => t.seq)).toEqual([1, 2, 3]);
        expect(turns.map(t => t.role)).toEqual(['user', 'assistant', 'user']);
        expect(turns.map(t => t.content)).toEqual(['what should I build?', 'tell me more', 'a widget']);
    });

    it('scopes since by card, leaving another card on the same project untouched', async () => {
        await repo.append('0001', 'user', 'card one');
        await repo.append('0002', 'user', 'card two');

        const cardOneTurns = await repo.since('0001', 0);
        expect(cardOneTurns).toHaveLength(1);
        expect(cardOneTurns[0]?.content).toBe('card one');
    });

    it('is not an error to read the most recent engineSessionId for a card with no turns', async () => {
        await expect(repo.latestEngineSessionId('never-touched')).resolves.toBeUndefined();
    });

    it('returns the most recent engineSessionId among turns that have one, ignoring later turns that lack it', async () => {
        await repo.append('0001', 'user', 'first message');
        await repo.append('0001', 'assistant', 'first reply', 'session-a');
        await repo.append('0001', 'user', 'second message');
        await repo.append('0001', 'assistant', 'second reply', 'session-b');

        await expect(repo.latestEngineSessionId('0001')).resolves.toBe('session-b');
    });

    it('leaves engineSessionId undefined, not null, when a turn is appended without one', async () => {
        const turn = await repo.append('0001', 'user', 'no session on this one');

        expect(turn.engineSessionId).toBeUndefined();

        const [reread] = await repo.since('0001', 0);
        expect(reread?.engineSessionId).toBeUndefined();
        expect(reread?.engineSessionId).not.toBeNull();
    });
});
