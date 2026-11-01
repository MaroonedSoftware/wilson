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
        config = new StaticBoardConfig(uniqueProject(), '/tmp/code', '/tmp/wt', '/tmp/run');
        repo = new PlanTurnRepository(config, db);
    });

    /**
     * Card 0131's acceptance criteria: appending turns for a card yields `seq` values that increase
     * monotonically from that card's own start, and two different cards do not share a counter.
     */
    it('assigns seq starting at 1 and increasing monotonically per card, independent of other cards', async () => {
        const first = await repo.append('0001', 'user', 'hello');
        const second = await repo.append('0001', 'assistant', 'hi there');
        const third = await repo.append('0001', 'user', 'again');

        expect(first.seq).toBe(1);
        expect(second.seq).toBe(2);
        expect(third.seq).toBe(3);

        // A second card starts its own counter at 1 rather than continuing the first card's.
        const otherFirst = await repo.append('0002', 'user', 'unrelated');
        expect(otherFirst.seq).toBe(1);

        // The first card's own counter is untouched by the other card's inserts.
        const fourth = await repo.append('0001', 'assistant', 'once more');
        expect(fourth.seq).toBe(4);
    });

    it('scopes the seq counter by project as well as card id, so a same-id card elsewhere starts at 1 too', async () => {
        await repo.append('0001', 'user', 'hello');
        await repo.append('0001', 'user', 'hello again');

        const otherConfig = new StaticBoardConfig(uniqueProject(), '/tmp/code', '/tmp/wt', '/tmp/run');
        const otherRepo = new PlanTurnRepository(otherConfig, db);

        const turn = await otherRepo.append('0001', 'user', 'hello from elsewhere');
        expect(turn.seq).toBe(1);
    });

    /**
     * Acceptance criteria: reading from an exclusive `seq` bound returns every turn after it and
     * never the turn at it.
     */
    it('since returns every turn strictly after the given seq, excluding the turn at that seq', async () => {
        await repo.append('0001', 'user', 'first');
        await repo.append('0001', 'assistant', 'second');
        await repo.append('0001', 'user', 'third');

        const afterZero = await repo.since('0001', 0);
        expect(afterZero.map(t => t.content)).toEqual(['first', 'second', 'third']);

        const afterOne = await repo.since('0001', 1);
        expect(afterOne.map(t => t.content)).toEqual(['second', 'third']);
        expect(afterOne.some(t => t.seq === 1)).toBe(false);

        const afterLast = await repo.since('0001', 3);
        expect(afterLast).toEqual([]);
    });

    /** Acceptance criteria: a card's turns read back in seq order. */
    it('reads a card turns back in seq order', async () => {
        await repo.append('0001', 'user', 'one');
        await repo.append('0001', 'assistant', 'two');
        await repo.append('0001', 'user', 'three');

        const turns = await repo.since('0001', 0);
        expect(turns.map(t => t.seq)).toEqual([1, 2, 3]);
    });

    it('since scopes by both project and card, never returning another card or project turn', async () => {
        await repo.append('0001', 'user', 'mine');
        await repo.append('0002', 'user', 'a different card, same project');

        const otherConfig = new StaticBoardConfig(uniqueProject(), '/tmp/code', '/tmp/wt', '/tmp/run');
        const otherRepo = new PlanTurnRepository(otherConfig, db);
        await otherRepo.append('0001', 'user', 'same id, different project');

        const turns = await repo.since('0001', 0);
        expect(turns.map(t => t.content)).toEqual(['mine']);
    });

    /** Acceptance criteria: reading the most recent engine_session_id for a card with no turns is not an error. */
    it('latestEngineSessionId resolves to undefined for a card with no turns, rather than throwing', async () => {
        await expect(repo.latestEngineSessionId('no-such-card')).resolves.toBeUndefined();
    });

    it('latestEngineSessionId is undefined when turns exist but none carries a session id', async () => {
        await repo.append('0001', 'user', 'hello');

        await expect(repo.latestEngineSessionId('0001')).resolves.toBeUndefined();
    });

    it('latestEngineSessionId returns the most recently recorded session id, not the first one', async () => {
        await repo.append('0001', 'user', 'hello');
        await repo.append('0001', 'assistant', 'reply one', 'session-old');
        await repo.append('0001', 'user', 'more');
        await repo.append('0001', 'assistant', 'reply two', 'session-new');

        await expect(repo.latestEngineSessionId('0001')).resolves.toBe('session-new');
    });

    /**
     * The engine session id is set on the assistant row a turn produced and left null on the user
     * row that prompted it — a later assistant turn with no session id must not blank out the one
     * a prior turn recorded.
     */
    it('latestEngineSessionId ignores a later turn that carries no session id of its own', async () => {
        await repo.append('0001', 'assistant', 'reply', 'session-abc');
        await repo.append('0001', 'user', 'thanks');

        await expect(repo.latestEngineSessionId('0001')).resolves.toBe('session-abc');
    });

    it('append stores and round-trips the role and content verbatim, and stamps a createdAt', async () => {
        const turn = await repo.append('0001', 'assistant', 'the reply body', 'session-xyz');

        expect(turn.role).toBe('assistant');
        expect(turn.content).toBe('the reply body');
        expect(turn.engineSessionId).toBe('session-xyz');
        expect(turn.createdAt).toBeDefined();

        const [stored] = await repo.since('0001', 0);
        expect(stored!.role).toBe('assistant');
        expect(stored!.content).toBe('the reply body');
        expect(stored!.engineSessionId).toBe('session-xyz');
    });
});
