import { Injectable } from 'injectkit';
import { httpError } from '@maroonedsoftware/errors';
import type { MultipartBody } from '@maroonedsoftware/multipart';
import { BoardConfig } from '#modules/board/board.config.js';
import { BoardRepository } from '#modules/board/board.repository.js';
import { CardNotFoundError } from '#modules/board/postgres.board.repository.js';
import { EventLog } from '#modules/events/event.log.js';
import type { CardAttachment } from '../../generated/context.js';
import {
    MAX_ATTACHMENT_BYTES,
    MAX_ATTACHMENT_BYTES_PER_CARD,
    MAX_ATTACHMENTS_PER_CARD,
    contentHash,
    parseAttachmentId,
    safeFilename,
    sniffImageType,
    type AttachmentImageType,
} from './attachment.bytes.js';
import { CardAttachmentRepository, type StoredAttachment } from './card.attachment.repository.js';

/** Same value and reason as `ContextService`'s `FETCHED_BY`: there is one account. */
const ADDED_BY = 'human';

/** Sent with every download, so an upload can never be served as something a browser will execute. */
const X_CONTENT_TYPE_OPTIONS = 'nosniff';
const CONTENT_SECURITY_POLICY = "default-src 'none'";

const MEGABYTE = 1024 * 1024;

/**
 * `context.ck`'s attachment operations: the HTTP surface over `CardAttachmentRepository`, with the
 * rules themselves in `attachment.bytes.ts`.
 *
 * Thin, following `ContextService`'s shape. Each refusal is a 400 with its own `details.reason`
 * sentence, never collapsed to one message. The per-file cap is not among them: it is the parser's
 * own limit, and the parser answers 413.
 */
@Injectable()
export class AttachmentService {
    constructor(
        private readonly boardRepository: BoardRepository,
        private readonly boardConfig: BoardConfig,
        private readonly attachments: CardAttachmentRepository,
        private readonly eventLog: EventLog,
    ) {}

    /** Check the single uploaded file against every rule, store it, and record that it was added. */
    async attach(id: string, multipart: MultipartBody): Promise<CardAttachment> {
        await this.readOrThrow(id);

        const uploads: { bytes: Buffer; filename: string; declaredType: string }[] = [];
        await multipart.parse(
            async (_fieldname, stream, filename, _encoding, declaredType) => {
                const chunks: Buffer[] = [];
                for await (const chunk of stream) chunks.push(chunk as Buffer);
                uploads.push({ bytes: Buffer.concat(chunks), filename, declaredType });
            },
            { files: 1, fileSize: MAX_ATTACHMENT_BYTES, fields: 1 },
        );

        // A request with no file part parses successfully and never calls the handler above.
        const upload = uploads[0];
        if (!upload) throw refusal('the request has no file part');
        const { bytes, filename, declaredType } = upload;

        if (bytes.length === 0) throw refusal('the uploaded file is empty');

        const contentType = sniffImageType(bytes);
        if (!contentType) throw refusal("the file's bytes are not a PNG, JPEG, WebP or GIF image");
        if (contentType !== declaredType) throw refusal(`the file was declared ${declaredType} but its bytes are ${contentType}`);

        const totals = await this.attachments.totals(id);
        if (totals.count >= MAX_ATTACHMENTS_PER_CARD) throw refusal(`this card already holds the maximum of ${MAX_ATTACHMENTS_PER_CARD} attachments`);
        if (totals.bytes + bytes.length > MAX_ATTACHMENT_BYTES_PER_CARD) {
            throw refusal(`this upload would take the card past its ${MAX_ATTACHMENT_BYTES_PER_CARD / MEGABYTE} MB total for attachments`);
        }

        const stored = await this.attachments.insert(id, {
            filename: safeFilename(filename),
            contentType,
            contentHash: contentHash(bytes),
            bytes,
            addedBy: ADDED_BY,
        });
        await this.record('attachment.added', id, stored);
        return toGenerated(stored);
    }

    /** A card's attachments as metadata, oldest first. */
    async list(id: string): Promise<CardAttachment[]> {
        await this.readOrThrow(id);
        return (await this.attachments.list(id)).map(toGenerated);
    }

    /** One attachment's bytes, under the type they were sniffed as, with the two fixed security headers. */
    async bytes(
        id: string,
        attachmentId: string,
    ): Promise<{ contentType: AttachmentImageType; body: Buffer; headers: { xContentTypeOptions: string; contentSecurityPolicy: string } }> {
        await this.readOrThrow(id);
        const rowId = parseAttachmentId(attachmentId);
        if (!rowId) throw httpError(404);
        const attachment = await this.attachments.read(id, rowId);
        if (!attachment) throw httpError(404);
        return {
            // `attach` only ever stores what `sniffImageType` returned.
            contentType: attachment.contentType as AttachmentImageType,
            body: attachment.bytes,
            headers: { xContentTypeOptions: X_CONTENT_TYPE_OPTIONS, contentSecurityPolicy: CONTENT_SECURITY_POLICY },
        };
    }

    /**
     * Remove one attachment. 404 for either half of the path being wrong, the same shape of miss
     * `ContextService.remove` answers, and also for an id no row could have.
     */
    async remove(id: string, attachmentId: string): Promise<void> {
        await this.readOrThrow(id);
        const rowId = parseAttachmentId(attachmentId);
        if (!rowId) throw httpError(404);
        const attachment = await this.attachments.remove(id, rowId);
        if (!attachment) throw httpError(404);
        await this.record('attachment.removed', id, attachment);
    }

    private async record(type: 'attachment.added' | 'attachment.removed', cardId: string, attachment: StoredAttachment): Promise<void> {
        await this.eventLog.append({
            project: this.boardConfig.project,
            cardId,
            type,
            payload: { attachmentId: attachment.id, contentType: attachment.contentType, byteSize: attachment.byteSize },
        });
    }

    private async readOrThrow(id: string): Promise<void> {
        try {
            await this.boardRepository.read(id);
        } catch (err) {
            if (err instanceof CardNotFoundError) throw httpError(404);
            throw err;
        }
    }
}

const refusal = (reason: string) => httpError(400).withDetails({ reason });

function toGenerated(attachment: StoredAttachment): CardAttachment {
    return {
        id: attachment.id,
        filename: attachment.filename,
        contentType: attachment.contentType,
        byteSize: attachment.byteSize,
        contentHash: attachment.contentHash,
        addedBy: attachment.addedBy,
        createdAt: attachment.createdAt,
    };
}
