import { Injectable } from 'injectkit';
import { Kysely } from 'kysely';
import { DateTime } from 'luxon';
import type { DB } from '#modules/data/db.js';

/** How long an upload no message has claimed is kept: long enough to retry a send that failed. */
export const UNCLAIMED_ATTACHMENT_HOURS = 24;

export interface StoredChatAttachment {
    id: string;
    threadId: string;
    /** The message that carries it; undefined until one has claimed it. */
    messageSeq?: number;
    filename: string;
    contentType: string;
    byteSize: number;
    contentHash: string;
    createdAt: DateTime;
}

export interface StoredChatAttachmentWithBytes extends StoredChatAttachment {
    bytes: Buffer;
}

export interface NewChatAttachment {
    filename: string;
    contentType: string;
    contentHash: string;
    bytes: Buffer;
}

/** Every column but `bytes`, so a query has to ask for the bytes to get them. */
const METADATA_COLUMNS = ['id', 'threadId', 'messageSeq', 'filename', 'contentType', 'byteSize', 'contentHash', 'createdAt'] as const;

/**
 * `wilson.chat_attachments` — an image sent in a chat. See the migration
 * (`data/migrations/20261103250000_chat_attachments.sql`) for what a row holds and why.
 *
 * Every read is scoped by thread: an id that belongs to another thread misses exactly like one that
 * does not exist.
 */
@Injectable()
export class ChatAttachmentRepository {
    constructor(private readonly db: Kysely<DB>) {}

    /** Record an upload no message has claimed yet. */
    async insert(threadId: string, attachment: NewChatAttachment): Promise<StoredChatAttachment> {
        const row = await this.db
            .insertInto('wilson.chatAttachments')
            .values({
                threadId: BigInt(threadId),
                filename: attachment.filename,
                contentType: attachment.contentType,
                byteSize: attachment.bytes.length,
                contentHash: attachment.contentHash,
                bytes: attachment.bytes,
            })
            .returning(METADATA_COLUMNS)
            .executeTakeFirstOrThrow();
        return toStored(row);
    }

    /** A thread's images that messages carry, oldest first, with no bytes: a thread full of images still loads small. */
    async listClaimed(threadId: string): Promise<StoredChatAttachment[]> {
        const rows = await this.db
            .selectFrom('wilson.chatAttachments')
            .select(METADATA_COLUMNS)
            .where('threadId', '=', BigInt(threadId))
            .where('messageSeq', 'is not', null)
            .orderBy('id')
            .execute();
        return rows.map(toStored);
    }

    /** One image with its bytes, or `undefined` if it does not exist or belongs to another thread. */
    async read(threadId: string, id: string): Promise<StoredChatAttachmentWithBytes | undefined> {
        const row = await this.db
            .selectFrom('wilson.chatAttachments')
            .select([...METADATA_COLUMNS, 'bytes'])
            .where('threadId', '=', BigInt(threadId))
            .where('id', '=', BigInt(id))
            .executeTakeFirst();
        return row ? { ...toStored(row), bytes: row.bytes } : undefined;
    }

    /** Uploads in this thread that no message has claimed, with their bytes, oldest first. An id that is neither is simply absent. */
    async readUnclaimed(threadId: string, ids: string[]): Promise<StoredChatAttachmentWithBytes[]> {
        if (ids.length === 0) return [];
        const rows = await this.db
            .selectFrom('wilson.chatAttachments')
            .select([...METADATA_COLUMNS, 'bytes'])
            .where('threadId', '=', BigInt(threadId))
            .where('messageSeq', 'is', null)
            .where('id', 'in', ids.map(BigInt))
            .orderBy('id')
            .execute();
        return rows.map(row => ({ ...toStored(row), bytes: row.bytes }));
    }

    /** The images these messages carry, with their bytes, oldest first: what an engine that replays is given. */
    async readForMessages(threadId: string, seqs: number[]): Promise<StoredChatAttachmentWithBytes[]> {
        if (seqs.length === 0) return [];
        const rows = await this.db
            .selectFrom('wilson.chatAttachments')
            .select([...METADATA_COLUMNS, 'bytes'])
            .where('threadId', '=', BigInt(threadId))
            .where('messageSeq', 'in', seqs)
            .orderBy('id')
            .execute();
        return rows.map(row => ({ ...toStored(row), bytes: row.bytes }));
    }

    /** Remove uploads no message claimed within {@link UNCLAIMED_ATTACHMENT_HOURS}, in any thread; how many went. */
    async sweepUnclaimed(now: DateTime = DateTime.now()): Promise<number> {
        const result = await this.db
            .deleteFrom('wilson.chatAttachments')
            .where('messageSeq', 'is', null)
            .where('createdAt', '<', now.minus({ hours: UNCLAIMED_ATTACHMENT_HOURS }))
            .executeTakeFirst();
        return Number(result.numDeletedRows);
    }
}

function toStored(row: {
    id: bigint;
    threadId: bigint;
    messageSeq: number | null;
    filename: string;
    contentType: string;
    byteSize: number;
    contentHash: string;
    createdAt: DateTime;
}): StoredChatAttachment {
    return {
        id: String(row.id),
        threadId: String(row.threadId),
        messageSeq: row.messageSeq ?? undefined,
        filename: row.filename,
        contentType: row.contentType,
        byteSize: row.byteSize,
        contentHash: row.contentHash,
        createdAt: row.createdAt,
    };
}
