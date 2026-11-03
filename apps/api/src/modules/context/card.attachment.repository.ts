import { Kysely } from 'kysely';
import type { DateTime } from 'luxon';
import { BoardConfig } from '#modules/board/board.config.js';
import type { DB } from '#modules/data/db.js';

export interface StoredAttachment {
    id: string;
    filename: string;
    contentType: string;
    byteSize: number;
    contentHash: string;
    addedBy: string;
    createdAt: DateTime;
}

export interface StoredAttachmentWithBytes extends StoredAttachment {
    bytes: Buffer;
}

export interface NewAttachment {
    filename: string;
    contentType: string;
    contentHash: string;
    bytes: Buffer;
    addedBy: string;
}

/** Every column but `bytes`, so a query has to ask for the bytes to get them. */
const METADATA_COLUMNS = ['id', 'filename', 'contentType', 'byteSize', 'contentHash', 'addedBy', 'createdAt'] as const;

/**
 * `wilson.card_attachments` — an image kept on a card. Follows `CardContextRepository`'s shape and
 * is undecorated for the same reason: `ContextModule` registers it with a factory.
 *
 * `AttachmentService` is the one caller, and it validates an id with `parseAttachmentId` before
 * passing it here. See the migration (`data/migrations/20261103000000_card_attachments.sql`) for
 * what a row holds and why.
 */
export class CardAttachmentRepository {
    constructor(
        private readonly config: BoardConfig,
        private readonly db: Kysely<DB>,
    ) {}

    /** Record a new attachment on a card. */
    async insert(cardId: string, attachment: NewAttachment): Promise<StoredAttachment> {
        const row = await this.db
            .insertInto('wilson.cardAttachments')
            .values({
                project: this.config.project,
                cardId,
                filename: attachment.filename,
                contentType: attachment.contentType,
                byteSize: attachment.bytes.length,
                contentHash: attachment.contentHash,
                bytes: attachment.bytes,
                addedBy: attachment.addedBy,
            })
            .returning(METADATA_COLUMNS)
            .executeTakeFirstOrThrow();
        return toStoredAttachment(row);
    }

    /** A card's attachments, oldest first, with no bytes: a card at its total cap still lists small. */
    async list(cardId: string): Promise<StoredAttachment[]> {
        const rows = await this.db
            .selectFrom('wilson.cardAttachments')
            .select(METADATA_COLUMNS)
            .where('project', '=', this.config.project)
            .where('cardId', '=', cardId)
            .orderBy('id')
            .execute();
        return rows.map(toStoredAttachment);
    }

    /** One attachment with its bytes, or `undefined` if it does not exist or belongs to another card or project. */
    async read(cardId: string, id: string): Promise<StoredAttachmentWithBytes | undefined> {
        const row = await this.db
            .selectFrom('wilson.cardAttachments')
            .select([...METADATA_COLUMNS, 'bytes'])
            .where('project', '=', this.config.project)
            .where('cardId', '=', cardId)
            .where('id', '=', BigInt(id))
            .executeTakeFirst();
        return row ? { ...toStoredAttachment(row), bytes: row.bytes } : undefined;
    }

    /**
     * Delete one attachment. A real delete, as `CardContextRepository.remove` is, and scoped by
     * `cardId` for the same reason: an id that belongs to another card must miss exactly like one
     * that does not exist. Returns the row that went, or `undefined` for that miss, so
     * `AttachmentService` can answer it with its own 404 and record what was removed.
     */
    async remove(cardId: string, id: string): Promise<StoredAttachment | undefined> {
        const row = await this.db
            .deleteFrom('wilson.cardAttachments')
            .where('project', '=', this.config.project)
            .where('cardId', '=', cardId)
            .where('id', '=', BigInt(id))
            .returning(METADATA_COLUMNS)
            .executeTakeFirst();
        return row ? toStoredAttachment(row) : undefined;
    }

    /** How many attachments a card holds and how many bytes they total: what its caps are checked against. */
    async totals(cardId: string): Promise<{ count: number; bytes: number }> {
        const row = await this.db
            .selectFrom('wilson.cardAttachments')
            .select(({ fn }) => [fn.countAll<bigint | string>().as('count'), fn.sum<bigint | string | null>('byteSize').as('bytes')])
            .where('project', '=', this.config.project)
            .where('cardId', '=', cardId)
            .executeTakeFirstOrThrow();
        return { count: Number(row.count), bytes: Number(row.bytes ?? 0) };
    }
}

function toStoredAttachment(row: {
    id: bigint;
    filename: string;
    contentType: string;
    byteSize: number;
    contentHash: string;
    addedBy: string;
    createdAt: DateTime;
}): StoredAttachment {
    return {
        id: String(row.id),
        filename: row.filename,
        contentType: row.contentType,
        byteSize: row.byteSize,
        contentHash: row.contentHash,
        addedBy: row.addedBy,
        createdAt: row.createdAt,
    };
}
