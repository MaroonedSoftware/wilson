import { Readable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';
import type { MultipartBody } from '@maroonedsoftware/multipart';
import { AttachmentService } from '#modules/context/attachment.service.js';
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_CARD } from '#modules/context/attachment.bytes.js';
import { CardAttachmentRepository } from '#modules/context/card.attachment.repository.js';
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

const card = (id: string): Card => ({
    frontmatter: { id, title: `card ${id}`, stage: 'planning', dependsOn: [], retries: {} },
    sections: {},
    body: 'body text',
});

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (size = 64): Buffer => Buffer.concat([PNG_HEADER, Buffer.alloc(size - PNG_HEADER.length, 1)]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);

/** Stands in for `MultipartBody` with one file part, so every refusal the service owns needs no server. */
const upload = (bytes: Buffer, declaredType = 'image/png', filename = 'shot.png'): MultipartBody =>
    ({
        parse: async (handler: (...args: unknown[]) => Promise<void>) => {
            await handler('file', Readable.from([bytes]), filename, '7bit', declaredType);
            return new Map();
        },
    }) as unknown as MultipartBody;

/** A request that held no file part: the real parser resolves without ever calling the handler. */
const noFilePart = { parse: async () => new Map() } as unknown as MultipartBody;

describe('AttachmentService', () => {
    let config: StaticBoardConfig;
    let repository: CardAttachmentRepository;
    let append: ReturnType<typeof vi.fn>;
    let service: AttachmentService;

    beforeEach(async () => {
        config = new StaticBoardConfig(uniqueProject(), '/tmp/code', '/tmp/wt', '/tmp/run');
        repository = new CardAttachmentRepository(config, db);
        append = vi.fn(async () => {});
        const events = { append } as unknown as EventLog;
        const board = new PostgresBoardRepository(config, db, { append: vi.fn(async () => {}) } as unknown as EventLog);
        await board.create(card('0001'), 'seed');
        await board.create(card('0002'), 'seed');
        service = new AttachmentService(board, config, repository, events);
    });

    const refusalOf = async (promise: Promise<unknown>): Promise<{ statusCode: number; reason: string }> => {
        const err = (await promise.then(
            () => {
                throw new Error('expected a refusal');
            },
            (e: unknown) => e,
        )) as { statusCode: number; details?: { reason: string } };
        return { statusCode: err.statusCode, reason: err.details?.reason ?? '' };
    };

    it('stores the sniffed type and a sanitised name, and records one event', async () => {
        const attachment = await service.attach('0001', upload(png(), 'image/png', '../../evil name.png'));

        expect(attachment).toMatchObject({ filename: 'evil-name.png', contentType: 'image/png', byteSize: 64, addedBy: 'human' });
        expect(attachment.contentHash).toMatch(/^[0-9a-f]{64}$/);
        expect(append).toHaveBeenCalledTimes(1);
        expect(append).toHaveBeenCalledWith({
            project: config.project,
            cardId: '0001',
            type: 'attachment.added',
            payload: { attachmentId: attachment.id, contentType: 'image/png', byteSize: 64 },
        });
    });

    it.each([
        ['no file part', () => noFilePart, /no file part/],
        ['an empty file', () => upload(Buffer.alloc(0)), /empty/],
        ['text', () => upload(Buffer.from('just text'), 'text/plain'), /not a PNG/],
        ['SVG', () => upload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml'), /not a PNG/],
        ['a PNG declared as JPEG', () => upload(png(), 'image/jpeg'), /declared image\/jpeg but its bytes are image\/png/],
        ['a JPEG declared as PNG', () => upload(JPEG, 'image/png'), /declared image\/png but its bytes are image\/jpeg/],
    ])('refuses %s with 400, its own reason, no row and no event', async (_name, body, reason) => {
        const refused = await refusalOf(service.attach('0001', body()));

        expect(refused.statusCode).toBe(400);
        expect(refused.reason).toMatch(reason);
        expect(await repository.list('0001')).toEqual([]);
        expect(append).not.toHaveBeenCalled();
    });

    it('refuses an upload past the count cap', async () => {
        for (let i = 0; i < MAX_ATTACHMENTS_PER_CARD; i++) await service.attach('0001', upload(png()));
        append.mockClear();

        const refused = await refusalOf(service.attach('0001', upload(png())));

        expect(refused.statusCode).toBe(400);
        expect(refused.reason).toMatch(/maximum of 10 attachments/);
        expect(await repository.list('0001')).toHaveLength(MAX_ATTACHMENTS_PER_CARD);
        expect(append).not.toHaveBeenCalled();
    });

    it('refuses an upload past the total-bytes cap while the count cap still has room', async () => {
        for (let i = 0; i < 4; i++) await service.attach('0001', upload(png(MAX_ATTACHMENT_BYTES)));

        const refused = await refusalOf(service.attach('0001', upload(png())));

        expect(refused.statusCode).toBe(400);
        expect(refused.reason).toMatch(/20 MB total/);
        expect(await repository.list('0001')).toHaveLength(4);
    });

    it('fetches bytes under the sniffed type with the two fixed headers', async () => {
        const bytes = png();
        const { id } = await service.attach('0001', upload(bytes));

        const fetched = await service.bytes('0001', id);

        expect(fetched.contentType).toBe('image/png');
        expect(Buffer.compare(fetched.body, bytes)).toBe(0);
        expect(fetched.headers).toEqual({ xContentTypeOptions: 'nosniff', contentSecurityPolicy: "default-src 'none'" });
    });

    it('lists metadata with no bytes', async () => {
        await service.attach('0001', upload(png()));

        const [listed] = await service.list('0001');

        expect(listed).toMatchObject({ contentType: 'image/png' });
        expect(listed).not.toHaveProperty('bytes');
    });

    it('removes for good and records one event', async () => {
        const { id } = await service.attach('0001', upload(png()));
        append.mockClear();

        await service.remove('0001', id);

        expect(await repository.list('0001')).toEqual([]);
        expect(append).toHaveBeenCalledTimes(1);
        expect(append).toHaveBeenCalledWith({
            project: config.project,
            cardId: '0001',
            type: 'attachment.removed',
            payload: { attachmentId: id, contentType: 'image/png', byteSize: 64 },
        });
    });

    it('answers 404 for an unknown card on every operation', async () => {
        expect((await refusalOf(service.attach('9999', upload(png())))).statusCode).toBe(404);
        expect((await refusalOf(service.list('9999'))).statusCode).toBe(404);
        expect((await refusalOf(service.bytes('9999', '1'))).statusCode).toBe(404);
        expect((await refusalOf(service.remove('9999', '1'))).statusCode).toBe(404);
    });

    it("answers 404 for another card's attachment, and leaves it alone", async () => {
        const { id } = await service.attach('0001', upload(png()));
        append.mockClear();

        expect((await refusalOf(service.bytes('0002', id))).statusCode).toBe(404);
        expect((await refusalOf(service.remove('0002', id))).statusCode).toBe(404);

        expect(await repository.list('0001')).toHaveLength(1);
        expect(append).not.toHaveBeenCalled();
    });

    it.each(['abc', '0x10', '007', '99999999999999999999'])('answers 404 for the id %j, without reaching the repository', async attachmentId => {
        const read = vi.spyOn(repository, 'read');
        const remove = vi.spyOn(repository, 'remove');

        expect((await refusalOf(service.bytes('0001', attachmentId))).statusCode).toBe(404);
        expect((await refusalOf(service.remove('0001', attachmentId))).statusCode).toBe(404);

        expect(read).not.toHaveBeenCalled();
        expect(remove).not.toHaveBeenCalled();
    });
});
