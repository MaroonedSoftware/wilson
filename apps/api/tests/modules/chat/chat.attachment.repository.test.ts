import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { DateTime } from 'luxon';
import { ChatAttachmentRepository, UNCLAIMED_ATTACHMENT_HOURS, type NewChatAttachment } from '#modules/chat/chat.attachment.repository.js';
import { ChatThreadRepository } from '#modules/chat/chat.thread.repository.js';
import type { DB } from '#modules/data/db.js';
import { testDb } from '#tests/support/test.db.js';

let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

const image = (bytes: Buffer, filename = 'a.png'): NewChatAttachment => ({ filename, contentType: 'image/png', contentHash: 'hash', bytes });

describe('ChatAttachmentRepository', () => {
    const repo = () => new ChatAttachmentRepository(db);
    const newThread = async () => (await new ChatThreadRepository(db).create('a thread', 'api')).id;
    const claim = (id: string, messageSeq: number) =>
        db.updateTable('wilson.chatAttachments').set({ messageSeq }).where('id', '=', BigInt(id)).execute();

    it('inserts unclaimed, with byteSize taken from the bytes, and hands back no bytes', async () => {
        const thread = await newThread();

        const stored = await repo().insert(thread, image(Buffer.from([1, 2, 3])));

        expect(stored).toMatchObject({ threadId: thread, filename: 'a.png', contentType: 'image/png', byteSize: 3, contentHash: 'hash' });
        expect(stored.createdAt).toBeInstanceOf(DateTime);
        expect(stored.messageSeq).toBeUndefined();
        expect(stored).not.toHaveProperty('bytes');
    });

    it('reads the bytes back, and misses an id from another thread like one that does not exist', async () => {
        const thread = await newThread();
        const other = await newThread();
        const stored = await repo().insert(thread, image(Buffer.from([1, 2, 3])));

        expect((await repo().read(thread, stored.id))?.bytes).toEqual(Buffer.from([1, 2, 3]));
        expect(await repo().read(other, stored.id)).toBeUndefined();
        expect(await repo().read(thread, '999999999')).toBeUndefined();
    });

    it('lists only what a message claimed, oldest first, with no bytes', async () => {
        const thread = await newThread();
        const first = await repo().insert(thread, image(Buffer.from([1]), 'first.png'));
        const second = await repo().insert(thread, image(Buffer.from([2]), 'second.png'));
        await repo().insert(thread, image(Buffer.from([3]), 'unclaimed.png'));
        await claim(second.id, 1);
        await claim(first.id, 1);

        const listed = await repo().listClaimed(thread);

        expect(listed.map(row => row.filename)).toEqual(['first.png', 'second.png']);
        expect(listed[0]).toMatchObject({ messageSeq: 1 });
        expect(listed[0]).not.toHaveProperty('bytes');
    });

    it('sweeps old unclaimed uploads, and leaves recent ones and claimed ones', async () => {
        const thread = await newThread();
        const recent = await repo().insert(thread, image(Buffer.from([1])));
        const claimed = await repo().insert(thread, image(Buffer.from([2])));
        await claim(claimed.id, 1);
        const swept = await repo().insert(thread, image(Buffer.from([3])));

        const old = DateTime.now().minus({ hours: UNCLAIMED_ATTACHMENT_HOURS + 1 });
        await db
            .updateTable('wilson.chatAttachments')
            .set({ createdAt: old })
            .where('id', 'in', [BigInt(swept.id), BigInt(claimed.id)])
            .execute();

        await repo().sweepUnclaimed();

        expect(await repo().read(thread, swept.id)).toBeUndefined();
        expect(await repo().read(thread, recent.id)).toBeDefined();
        expect(await repo().read(thread, claimed.id)).toBeDefined();
    });

    it('goes when its thread does', async () => {
        const thread = await newThread();
        const stored = await repo().insert(thread, image(Buffer.from([1])));

        await db.deleteFrom('wilson.chatThreads').where('id', '=', BigInt(thread)).execute();

        expect(await repo().read(thread, stored.id)).toBeUndefined();
    });
});
