import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';
import { DateTime } from 'luxon';
import { CardContextRepository } from '#modules/context/card.context.repository.js';
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

const fetchedAt = DateTime.fromISO('2026-09-01T12:00:00.000Z');

describe('CardContextRepository', () => {
    let repo: CardContextRepository;
    let config: StaticBoardConfig;
    let board: PostgresBoardRepository;

    beforeEach(async () => {
        config = new StaticBoardConfig(uniqueProject(), '/tmp/code', '/tmp/wt', '/tmp/run');
        repo = new CardContextRepository(config, db);
        board = new PostgresBoardRepository(config, db, fakeEvents);
        // The table's FK ties a snapshot to a real (project, card_id) — every test needs a card row
        // to attach snapshots to, the same reason `PlanCommentRepository`'s tests do.
        await board.create(card('0001'), 'seed');
    });

    it('round-trips the manifest and content exactly, with fetchedAt and createdAt as Luxon DateTime', async () => {
        const snapshot = await repo.attach('0001', 'https://example.com/doc', fetchedAt, 'url-provider', 'A title', 'the fetched content', 'hash-1');

        expect(snapshot.sourceUrl).toBe('https://example.com/doc');
        expect(snapshot.fetchedAt.toMillis()).toBe(fetchedAt.toMillis());
        expect(snapshot.fetchedBy).toBe('url-provider');
        expect(snapshot.title).toBe('A title');
        expect(snapshot.content).toBe('the fetched content');
        expect(snapshot.contentHash).toBe('hash-1');
        expect(snapshot.id).toBeDefined();
        expect(snapshot.createdAt).toBeInstanceOf(DateTime);
        expect(snapshot.fetchedAt).toBeInstanceOf(DateTime);

        // And reading it back from storage, not just the value `attach` handed back, agrees.
        const [stored] = await repo.list('0001');
        expect(stored).toEqual(snapshot);

        const got = await repo.get(snapshot.id);
        expect(got).toEqual(snapshot);
    });

    it('stores a missing title as SQL NULL and reads it back as undefined, never an empty string', async () => {
        const snapshot = await repo.attach('0001', 'https://example.com/doc', fetchedAt, 'url-provider', null, 'content', 'hash-1');

        expect(snapshot.title).toBeUndefined();
        const got = await repo.get(snapshot.id);
        expect(got?.title).toBeUndefined();
    });

    it('list returns a card\'s snapshots oldest first', async () => {
        const first = await repo.attach('0001', 'https://example.com/a', fetchedAt, 'url-provider', 'a', 'content a', 'hash-a');
        const second = await repo.attach('0001', 'https://example.com/b', fetchedAt, 'url-provider', 'b', 'content b', 'hash-b');

        const all = await repo.list('0001');

        expect(all.map(s => s.id)).toEqual([first.id, second.id]);
    });

    it('get returns undefined for a snapshot id that does not exist', async () => {
        await expect(repo.get('999999999')).resolves.toBeUndefined();
    });

    it('remove deletes one snapshot, reports it was deleted, and leaves the card\'s others intact', async () => {
        const first = await repo.attach('0001', 'https://example.com/a', fetchedAt, 'url-provider', 'a', 'content a', 'hash-a');
        const second = await repo.attach('0001', 'https://example.com/b', fetchedAt, 'url-provider', 'b', 'content b', 'hash-b');

        await expect(repo.remove('0001', first.id)).resolves.toBe(true);

        expect(await repo.get(first.id)).toBeUndefined();
        expect(await repo.get(second.id)).toEqual(second);
        expect((await repo.list('0001')).map(s => s.id)).toEqual([second.id]);
    });

    it('remove reports false, and deletes nothing, for a snapshot id that does not exist', async () => {
        await expect(repo.remove('0001', '999999999')).resolves.toBe(false);
    });

    it('remove reports false, and deletes nothing, for a snapshot id that belongs to a different card', async () => {
        await board.create(card('0002'), 'seed');
        const snapshot = await repo.attach('0001', 'https://example.com/a', fetchedAt, 'url-provider', 'a', 'content a', 'hash-a');

        await expect(repo.remove('0002', snapshot.id)).resolves.toBe(false);

        expect(await repo.get(snapshot.id)).toEqual(snapshot);
    });

    it('rejects attach for a card id with no matching card row, the composite FK\'s other half', async () => {
        // The FK is `(project, card_id) REFERENCES wilson.cards (project, id)` — cascade-on-delete
        // is only half of what that buys; a snapshot must never land for a card that never existed
        // in the first place.
        await expect(repo.attach('no-such-card', 'https://example.com/a', fetchedAt, 'url-provider', 'a', 'content a', 'hash-a')).rejects.toThrow();

        expect(await repo.list('no-such-card')).toEqual([]);
    });

    it('cascades on card deletion: deleting the card removes its snapshots', async () => {
        const snapshot = await repo.attach('0001', 'https://example.com/a', fetchedAt, 'url-provider', 'a', 'content a', 'hash-a');

        // `PostgresBoardRepository` has no delete method — the composite FK's `ON DELETE CASCADE`
        // is exercised directly against the card row it references.
        await db.deleteFrom('wilson.cards').where('project', '=', config.project).where('id', '=', '0001').execute();

        expect(await repo.get(snapshot.id)).toBeUndefined();
        expect(await repo.list('0001')).toEqual([]);
    });

    it('scopes list and get by project, never returning another project\'s snapshot', async () => {
        const snapshot = await repo.attach('0001', 'https://example.com/a', fetchedAt, 'url-provider', 'a', 'content a', 'hash-a');

        const otherConfig = new StaticBoardConfig(uniqueProject(), '/tmp/code', '/tmp/wt', '/tmp/run');
        const otherBoard = new PostgresBoardRepository(otherConfig, db, fakeEvents);
        await otherBoard.create(card('0001'), 'seed');
        const otherRepo = new CardContextRepository(otherConfig, db);

        expect(await otherRepo.list('0001')).toEqual([]);
        expect(await otherRepo.get(snapshot.id)).toBeUndefined();

        // The original project's snapshot is unaffected by the other project's card sharing an id.
        expect(await repo.list('0001')).toHaveLength(1);
    });

    it('scopes list by card id within the same project, never returning another card\'s snapshot', async () => {
        await board.create(card('0002'), 'seed');
        await repo.attach('0001', 'https://example.com/one', fetchedAt, 'url-provider', 'one', 'content one', 'hash-1');
        await repo.attach('0002', 'https://example.com/two', fetchedAt, 'url-provider', 'two', 'content two', 'hash-2');

        const cardOne = await repo.list('0001');
        expect(cardOne.map(s => s.title)).toEqual(['one']);

        const cardTwo = await repo.list('0002');
        expect(cardTwo.map(s => s.title)).toEqual(['two']);
    });
});
