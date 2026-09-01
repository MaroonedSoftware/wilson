import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';
import { PlanCommentRepository } from '#modules/plan/plan.comment.repository.js';
import { PostgresBoardRepository } from '#modules/board/postgres.board.repository.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';
import type { Card } from '#modules/board/card.js';
import type { EventLog } from '#modules/events/event.log.js';
import type { DB } from '#modules/data/db.js';

let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

const fakeEvents = { append: vi.fn(async () => {}) } as unknown as EventLog;

const card = (id: string): Card => ({
    frontmatter: { id, title: `card ${id}`, stage: 'planning', dependsOn: [], retries: {} },
    sections: {},
    body: 'body text',
});

describe('PlanCommentRepository', () => {
    let repo: PlanCommentRepository;
    let config: StaticBoardConfig;
    let board: PostgresBoardRepository;

    beforeEach(async () => {
        config = new StaticBoardConfig(uniqueProject(), '/tmp/code', '/tmp/wt', '/tmp/run');
        repo = new PlanCommentRepository(config, db);
        board = new PostgresBoardRepository(config, db, fakeEvents);
        // The table's FK ties a comment to a real (project, card_id) — unlike `runner.plan_turns`,
        // which carries no such constraint — so every test needs a card row to attach comments to.
        await board.create(card('0001'), 'seed');
    });

    it('round-trips the quote, its prefix/suffix window and the comment text exactly, open by default', async () => {
        const comment = await repo.append('0001', 'the quoted passage', 'before it, ', ', after it', 'this should say X instead');

        expect(comment.quote).toBe('the quoted passage');
        expect(comment.prefix).toBe('before it, ');
        expect(comment.suffix).toBe(', after it');
        expect(comment.text).toBe('this should say X instead');
        expect(comment.resolved).toBe(false);
        expect(comment.id).toBeDefined();
        expect(comment.createdAt).toBeDefined();

        // And reading it back from storage, not just the value `append` handed back, agrees.
        const [stored] = await repo.list('0001');
        expect(stored).toEqual(comment);
    });

    it('list returns both open and resolved comments, distinguishable, oldest first', async () => {
        const first = await repo.append('0001', 'q1', 'p1', 's1', 't1');
        const second = await repo.append('0001', 'q2', 'p2', 's2', 't2');
        await repo.resolve('0001', first.id);

        const all = await repo.list('0001');

        expect(all.map(c => c.id)).toEqual([first.id, second.id]);
        expect(all.find(c => c.id === first.id)?.resolved).toBe(true);
        expect(all.find(c => c.id === second.id)?.resolved).toBe(false);
    });

    it('open returns only the unresolved comments, in the same oldest-first order as list', async () => {
        const first = await repo.append('0001', 'q1', 'p1', 's1', 't1');
        const second = await repo.append('0001', 'q2', 'p2', 's2', 't2');
        await repo.resolve('0001', first.id);

        const open = await repo.open('0001');

        expect(open.map(c => c.id)).toEqual([second.id]);
    });

    it('resolve marks a comment resolved without deleting it, and hands back the updated row', async () => {
        const comment = await repo.append('0001', 'q', 'p', 's', 't');

        const resolved = await repo.resolve('0001', comment.id);

        expect(resolved?.resolved).toBe(true);
        expect(resolved?.id).toBe(comment.id);
        expect(resolved?.quote).toBe('q');

        // Still on record afterward — resolving is a state change, never a delete.
        const all = await repo.list('0001');
        expect(all).toHaveLength(1);
        expect(all[0]?.resolved).toBe(true);
    });

    it('resolve returns undefined, and leaves the comment untouched, for a comment id that does not belong to the given card', async () => {
        const comment = await repo.append('0001', 'q', 'p', 's', 't');

        await expect(repo.resolve('some-other-card', comment.id)).resolves.toBeUndefined();

        const all = await repo.list('0001');
        expect(all[0]?.resolved).toBe(false);
    });

    it('resolve returns undefined for a comment id that does not exist at all', async () => {
        await expect(repo.resolve('0001', '999999999')).resolves.toBeUndefined();
    });

    it('scopes list and open by project as well as card id, never returning another project\'s comment', async () => {
        await repo.append('0001', 'q', 'p', 's', 't');

        const otherConfig = new StaticBoardConfig(uniqueProject(), '/tmp/code', '/tmp/wt', '/tmp/run');
        const otherBoard = new PostgresBoardRepository(otherConfig, db, fakeEvents);
        await otherBoard.create(card('0001'), 'seed');
        const otherRepo = new PlanCommentRepository(otherConfig, db);

        expect(await otherRepo.list('0001')).toEqual([]);
        expect(await otherRepo.open('0001')).toEqual([]);

        // The original project's comment is unaffected by the other project's card sharing an id.
        expect(await repo.list('0001')).toHaveLength(1);
    });

    it('scopes list and open by card id within the same project, never returning another card\'s comment', async () => {
        await board.create(card('0002'), 'seed');
        await repo.append('0001', 'card one', 'p', 's', 't');
        await repo.append('0002', 'card two', 'p', 's', 't');

        const cardOne = await repo.list('0001');
        expect(cardOne.map(c => c.quote)).toEqual(['card one']);

        const cardTwo = await repo.open('0002');
        expect(cardTwo.map(c => c.quote)).toEqual(['card two']);
    });
});
