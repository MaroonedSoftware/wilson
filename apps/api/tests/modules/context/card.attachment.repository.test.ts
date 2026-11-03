import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';
import { DateTime } from 'luxon';
import { CardAttachmentRepository, type NewAttachment } from '#modules/context/card.attachment.repository.js';
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

const image = (bytes: Buffer, filename = 'a.png'): NewAttachment => ({
    filename,
    contentType: 'image/png',
    contentHash: 'hash',
    bytes,
    addedBy: 'human',
});

describe('CardAttachmentRepository', () => {
    let config: StaticBoardConfig;
    let repo: CardAttachmentRepository;

    beforeEach(async () => {
        config = new StaticBoardConfig(uniqueProject(), '/tmp/code', '/tmp/wt', '/tmp/run');
        repo = new CardAttachmentRepository(config, db);
        const board = new PostgresBoardRepository(config, db, fakeEvents);
        await board.create(card('0001'), 'seed');
        await board.create(card('0002'), 'seed');
    });

    it('inserts metadata with byteSize taken from the bytes, and hands back no bytes', async () => {
        const stored = await repo.insert('0001', image(Buffer.from([1, 2, 3])));

        expect(stored).toMatchObject({ filename: 'a.png', contentType: 'image/png', byteSize: 3, contentHash: 'hash', addedBy: 'human' });
        expect(stored.id).toEqual(expect.any(String));
        expect(stored.createdAt).toBeInstanceOf(DateTime);
        expect(stored).not.toHaveProperty('bytes');
    });

    it('lists oldest first, with no bytes', async () => {
        const first = await repo.insert('0001', image(Buffer.from([1]), 'first.png'));
        const second = await repo.insert('0001', image(Buffer.from([2]), 'second.png'));

        const rows = await repo.list('0001');

        expect(rows.map(row => row.id)).toEqual([first.id, second.id]);
        for (const row of rows) expect(row).not.toHaveProperty('bytes');
    });

    it('reads the exact bytes back, scoped by card', async () => {
        const bytes = Buffer.from([0, 255, 1, 254]);
        const stored = await repo.insert('0001', image(bytes));

        expect(Buffer.compare((await repo.read('0001', stored.id))!.bytes, bytes)).toBe(0);
        expect(await repo.read('0002', stored.id)).toBeUndefined();
    });

    it('removes a row for good, returning it, and misses across cards', async () => {
        const stored = await repo.insert('0001', image(Buffer.from([1])));

        expect(await repo.remove('0002', stored.id)).toBeUndefined();
        expect(await repo.list('0001')).toHaveLength(1);

        expect(await repo.remove('0001', stored.id)).toEqual(stored);
        expect(await repo.list('0001')).toEqual([]);
        expect(await repo.remove('0001', stored.id)).toBeUndefined();
    });

    it('totals only the named card, and an empty card is zero rather than null', async () => {
        await repo.insert('0001', image(Buffer.alloc(3)));
        await repo.insert('0001', image(Buffer.alloc(4)));
        await repo.insert('0002', image(Buffer.alloc(100)));

        expect(await repo.totals('0001')).toEqual({ count: 2, bytes: 7 });

        await db.deleteFrom('wilson.cardAttachments').where('project', '=', config.project).where('cardId', '=', '0002').execute();
        expect(await repo.totals('0002')).toEqual({ count: 0, bytes: 0 });
    });

    it('cannot see another project', async () => {
        const stored = await repo.insert('0001', image(Buffer.from([1])));
        const otherConfig = new StaticBoardConfig(uniqueProject(), '/tmp/code', '/tmp/wt', '/tmp/run');
        const other = new CardAttachmentRepository(otherConfig, db);
        await new PostgresBoardRepository(otherConfig, db, fakeEvents).create(card('0001'), 'seed');

        expect(await other.list('0001')).toEqual([]);
        expect(await other.read('0001', stored.id)).toBeUndefined();
        expect(await other.remove('0001', stored.id)).toBeUndefined();
        expect(await other.totals('0001')).toEqual({ count: 0, bytes: 0 });
    });

    it('goes with its card', async () => {
        await repo.insert('0001', image(Buffer.from([1])));

        await db.deleteFrom('wilson.cards').where('project', '=', config.project).where('id', '=', '0001').execute();

        expect(await repo.list('0001')).toEqual([]);
    });
});
