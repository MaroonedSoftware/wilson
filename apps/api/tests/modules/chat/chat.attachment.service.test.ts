import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { DateTime } from 'luxon';
import { ChatAttachmentRepository, UNCLAIMED_ATTACHMENT_HOURS } from '#modules/chat/chat.attachment.repository.js';
import { ChatAttachmentService } from '#modules/chat/chat.attachment.service.js';
import { ChatThreadRepository } from '#modules/chat/chat.thread.repository.js';
import { MAX_CREATED_SVG_BYTES } from '#modules/chat/chat.image.js';
import type { DB } from '#modules/data/db.js';
import { testDb } from '#tests/support/test.db.js';

let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(56, 1)]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(16, 1)]);

const service = () => new ChatAttachmentService(new ChatThreadRepository(db), new ChatAttachmentRepository(db));
const newThread = async () => (await new ChatThreadRepository(db).create('a thread', 'api')).id;
const rowsIn = (threadId: string) =>
    db.selectFrom('wilson.chatAttachments').select(['id', 'contentType', 'messageSeq', 'bytes', 'filename']).where('threadId', '=', BigInt(threadId)).execute();

const refusalOf = async (promise: Promise<unknown>): Promise<{ statusCode: number; details?: { reason?: string } }> => {
    try {
        await promise;
    } catch (error) {
        return error as { statusCode: number; details?: { reason?: string } };
    }
    throw new Error('expected a refusal');
};

describe('ChatAttachmentService.create', () => {
    it('stores valid SVG as one unclaimed image/svg+xml row, byte for byte, and returns it', async () => {
        const thread = await newThread();

        const stored = await service().create(thread, { kind: 'svg', source: SVG }, '../chart one.svg');

        expect(stored).toMatchObject({ threadId: thread, contentType: 'image/svg+xml', filename: 'chart-one.svg', byteSize: Buffer.byteLength(SVG) });
        expect(stored.messageSeq).toBeUndefined();
        const rows = await rowsIn(thread);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ id: BigInt(stored.id), contentType: 'image/svg+xml' });
        expect(rows[0]!.messageSeq ?? null).toBeNull();
        expect(rows[0]!.bytes.toString('utf8')).toBe(SVG);
    });

    it('stores valid bytes under the type sniffed from them', async () => {
        const thread = await newThread();

        const png = await service().create(thread, { kind: 'bytes', base64: PNG.toString('base64') }, 'a.png');
        const gif = await service().create(thread, { kind: 'bytes', base64: GIF.toString('base64') }, 'named-wrong.png');

        expect(png.contentType).toBe('image/png');
        expect(gif.contentType).toBe('image/gif');
        expect((await rowsIn(thread)).map(row => row.bytes)).toEqual([PNG, GIF]);
    });

    it('sweeps old unclaimed uploads as it stores', async () => {
        const thread = await newThread();
        const old = await new ChatAttachmentRepository(db).insert(thread, { filename: 'old.png', contentType: 'image/png', contentHash: 'h', bytes: PNG });
        await db
            .updateTable('wilson.chatAttachments')
            .set({ createdAt: DateTime.now().minus({ hours: UNCLAIMED_ATTACHMENT_HOURS + 1 }) })
            .where('id', '=', BigInt(old.id))
            .execute();

        const created = await service().create(thread, { kind: 'svg', source: SVG }, 'a.svg');

        expect((await rowsIn(thread)).map(row => String(row.id))).toEqual([created.id]);
    });

    it('stores nothing for refused SVG, and the 400 carries the scanner sentence', async () => {
        const thread = await newThread();

        const error = await refusalOf(service().create(thread, { kind: 'svg', source: '<svg><script>alert(1)</script></svg>' }, 'a.svg'));

        expect(error.statusCode).toBe(400);
        expect(error.details?.reason).toBe('the SVG contains a <script> element, which could run code');
        expect(await rowsIn(thread)).toEqual([]);
    });

    it('stores nothing for refused bytes: malformed base64, or an SVG smuggled as bytes', async () => {
        const thread = await newThread();

        const malformed = await refusalOf(service().create(thread, { kind: 'bytes', base64: 'not base64!' }, 'a.png'));
        expect(malformed.statusCode).toBe(400);
        expect(malformed.details?.reason).toBe('the image is not valid base64');

        const smuggled = await refusalOf(service().create(thread, { kind: 'bytes', base64: Buffer.from(SVG).toString('base64') }, 'a.svg'));
        expect(smuggled.statusCode).toBe(400);
        expect(smuggled.details?.reason).toMatch(/SVG must be sent as source/);

        expect(await rowsIn(thread)).toEqual([]);
    });

    it('stores nothing for SVG over the cap, and does not sweep on a refusal', async () => {
        const thread = await newThread();
        const old = await new ChatAttachmentRepository(db).insert(thread, { filename: 'old.png', contentType: 'image/png', contentHash: 'h', bytes: PNG });
        await db
            .updateTable('wilson.chatAttachments')
            .set({ createdAt: DateTime.now().minus({ hours: UNCLAIMED_ATTACHMENT_HOURS + 1 }) })
            .where('id', '=', BigInt(old.id))
            .execute();

        const big = `<svg xmlns="http://www.w3.org/2000/svg"><text>${'a'.repeat(MAX_CREATED_SVG_BYTES)}</text></svg>`;
        const error = await refusalOf(service().create(thread, { kind: 'svg', source: big }, 'a.svg'));

        expect(error.statusCode).toBe(400);
        expect(error.details?.reason).toMatch(/byte limit/);
        expect((await rowsIn(thread)).map(row => String(row.id))).toEqual([old.id]);
    });

    it('serves a created SVG back through bytes() as image/svg+xml with the fixed headers', async () => {
        const thread = await newThread();
        const created = await service().create(thread, { kind: 'svg', source: SVG }, 'a.svg');

        const served = await service().bytes(thread, created.id);

        expect(served.contentType).toBe('image/svg+xml');
        expect(served.body.toString('utf8')).toBe(SVG);
        expect(served.headers).toEqual({ xContentTypeOptions: 'nosniff', contentSecurityPolicy: "default-src 'none'" });
        await expect(service().bytes(await newThread(), created.id)).rejects.toMatchObject({ statusCode: 404 });
    });

    it('answers 404 for a thread that does not exist, before checking the image', async () => {
        const error = await refusalOf(service().create('999999999', { kind: 'svg', source: '<nope' }, 'a.svg'));
        expect(error.statusCode).toBe(404);
    });
});
