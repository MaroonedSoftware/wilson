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

    /**
     * Card 0131's core promise: `seq` is a per-card counter starting at that card's own beginning,
     * not a timestamp and not shared across cards. A card's first turn is 1, its next is 2, and a
     * completely different card appending afterwards still starts back at 1.
     */
    it('assigns seq starting at 1 for a card and increasing monotonically with each append', async () => {
        const first = await repo.append('0001', 'user', 'hello');
        const second = await repo.append('0001', 'assistant', 'hi there');
        const third = await repo.append('0001', 'user', 'again');

        expect(first.seq).toBe(1);
        expect(second.seq).toBe(2);
        expect(third.seq).toBe(3);
    });

    it('does not share a counter across cards — a second card starts at its own beginning', async () => {
        await repo.append('0001', 'user', 'first card, turn one');
        await repo.append('0001', 'assistant', 'first card, turn two');

        const other = await repo.append('0002', 'user', 'second card, turn one');

        expect(other.seq).toBe(1);
    });

    /**
     * `since` is what `Last-Event-ID` replay resumes from, and the bound is exclusive: the caller
     * already has the turn at `afterSeq`, so getting it back again would duplicate it in whatever
     * is rendering the transcript.
     */
    it('since returns every turn strictly after the given seq, never the turn at it', async () => {
        await repo.append('0001', 'user', 'turn one');
        await repo.append('0001', 'assistant', 'turn two');
        await repo.append('0001', 'user', 'turn three');

        const after1 = await repo.since('0001', 1);
        expect(after1.map(t => t.seq)).toEqual([2, 3]);
        expect(after1.map(t => t.content)).toEqual(['turn two', 'turn three']);

        const after0 = await repo.since('0001', 0);
        expect(after0.map(t => t.seq)).toEqual([1, 2, 3]);

        const afterLast = await repo.since('0001', 3);
        expect(afterLast).toEqual([]);
    });

    it('since returns turns in seq order', async () => {
        await repo.append('0001', 'user', 'a');
        await repo.append('0001', 'assistant', 'b');
        await repo.append('0001', 'user', 'c');
        await repo.append('0001', 'assistant', 'd');

        const turns = await repo.since('0001', 0);

        expect(turns.map(t => t.seq)).toEqual([1, 2, 3, 4]);
        expect(turns.map(t => t.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    });

    it('since scopes by project, not returning another card of the same id in a different project', async () => {
        await repo.append('0001', 'user', 'mine');

        const otherConfig = new StaticBoardConfig(uniqueProject(), '/tmp/board', '/tmp/code', '/tmp/wt', '/tmp/run');
        const otherRepo = new PlanTurnRepository(otherConfig, db);
        await otherRepo.append('0001', 'user', 'theirs');

        const mine = await repo.since('0001', 0);
        expect(mine).toHaveLength(1);
        expect(mine[0]?.content).toBe('mine');
    });

    /**
     * `engineSessionId` is set on the assistant turn that produced it and left absent on the user
     * turn that prompted it — `latestEngineSessionId` is what a restarted process resumes from, so
     * it has to find the value even though the very next (unrelated) row leaves it unset.
     */
    it('latestEngineSessionId reads the most recent non-null session id, ignoring turns with none', async () => {
        await repo.append('0001', 'user', 'hello');
        await repo.append('0001', 'assistant', 'hi', 'session-a');
        await repo.append('0001', 'user', 'more');

        expect(await repo.latestEngineSessionId('0001')).toBe('session-a');
    });

    it('latestEngineSessionId returns the newest session id once a later turn sets a different one', async () => {
        await repo.append('0001', 'user', 'hello');
        await repo.append('0001', 'assistant', 'hi', 'session-a');
        await repo.append('0001', 'user', 'continue');
        await repo.append('0001', 'assistant', 'more', 'session-b');

        expect(await repo.latestEngineSessionId('0001')).toBe('session-b');
    });

    /**
     * Explicit acceptance criterion: a card with no turns at all is not an error, it simply has
     * nothing to resume.
     */
    it('latestEngineSessionId for a card with no turns resolves to undefined rather than throwing', async () => {
        await expect(repo.latestEngineSessionId('9999')).resolves.toBeUndefined();
    });

    it('latestEngineSessionId for a card whose turns never set one also resolves to undefined', async () => {
        await repo.append('0001', 'user', 'hello');
        await repo.append('0001', 'assistant', 'hi, no session id here');

        expect(await repo.latestEngineSessionId('0001')).toBeUndefined();
    });

    it('append round-trips role and content, and stamps a createdAt', async () => {
        const turn = await repo.append('0001', 'assistant', 'the answer is 42', 'session-x');

        expect(turn.role).toBe('assistant');
        expect(turn.content).toBe('the answer is 42');
        expect(turn.engineSessionId).toBe('session-x');
        expect(turn.createdAt).toBeTruthy();
    });

    it('append leaves engineSessionId undefined, not null, when none is given', async () => {
        const turn = await repo.append('0001', 'user', 'no session here');

        expect(turn.engineSessionId).toBeUndefined();

        const [read] = await repo.since('0001', 0);
        expect(read?.engineSessionId).toBeUndefined();
    });
});
