import { httpError } from '@maroonedsoftware/errors';
import type { MultipartBody } from '@maroonedsoftware/multipart';
import { Injectable } from 'injectkit';
import { contentHash, parseAttachmentId, safeFilename, sniffImageType, type AttachmentImageType } from '#modules/context/attachment.bytes.js';
import type { ChatAttachment } from '#src/generated/chat.js';
import { ChatAttachmentRepository, type StoredChatAttachment } from './chat.attachment.repository.js';
import { ChatThreadRepository } from './chat.thread.repository.js';

/**
 * The largest image a chat takes. Lower than a card's, because a model's limit is on the base64 form of
 * an image, and 5 MB of base64 is 3.75 MB of image. The desktop app scales down to fit before it uploads.
 */
export const MAX_CHAT_IMAGE_BYTES = 3.75 * 1024 * 1024;

/** Sent with every download, as `AttachmentService` does, so an upload can never be served as something a browser will execute. */
const X_CONTENT_TYPE_OPTIONS = 'nosniff';
const CONTENT_SECURITY_POLICY = "default-src 'none'";

const refusal = (reason: string) => httpError(400).withDetails({ reason });

export const toWireAttachment = (attachment: StoredChatAttachment): ChatAttachment => ({
    id: attachment.id,
    filename: attachment.filename,
    contentType: attachment.contentType,
    byteSize: attachment.byteSize,
    contentHash: attachment.contentHash,
    createdAt: attachment.createdAt,
});

/**
 * `chat.ck`'s image operations: `AttachmentService`'s shape over `ChatAttachmentRepository`, with the
 * same rules for what counts as an image. Each refusal is a 400 with its own `details.reason`; the
 * per-file cap is the parser's own limit, and the parser answers 413.
 */
@Injectable()
export class ChatAttachmentService {
    constructor(
        private readonly threads: ChatThreadRepository,
        private readonly attachments: ChatAttachmentRepository,
    ) {}

    /** Check the single uploaded file, store it unclaimed, and clear out old uploads no message claimed. */
    async upload(id: string, multipart: MultipartBody): Promise<ChatAttachment> {
        await this.threadOrThrow(id);

        const uploads: { bytes: Buffer; filename: string; declaredType: string }[] = [];
        await multipart.parse(
            async (_fieldname, stream, filename, _encoding, declaredType) => {
                const chunks: Buffer[] = [];
                for await (const chunk of stream) chunks.push(chunk as Buffer);
                uploads.push({ bytes: Buffer.concat(chunks), filename, declaredType });
            },
            { files: 1, fileSize: MAX_CHAT_IMAGE_BYTES, fields: 1 },
        );

        // A request with no file part parses successfully and never calls the handler above.
        const upload = uploads[0];
        if (!upload) throw refusal('the request has no file part');
        const { bytes, filename, declaredType } = upload;

        if (bytes.length === 0) throw refusal('the uploaded file is empty');

        const contentType = sniffImageType(bytes);
        if (!contentType) throw refusal("the file's bytes are not a PNG, JPEG, WebP or GIF image");
        if (contentType !== declaredType) throw refusal(`the file was declared ${declaredType} but its bytes are ${contentType}`);

        const stored = await this.attachments.insert(id, {
            filename: safeFilename(filename),
            contentType,
            contentHash: contentHash(bytes),
            bytes,
        });
        await this.attachments.sweepUnclaimed();
        return toWireAttachment(stored);
    }

    /** One image's bytes, under the type they were sniffed as, with the two fixed security headers. */
    async bytes(
        id: string,
        attachmentId: string,
    ): Promise<{ contentType: AttachmentImageType; body: Buffer; headers: { xContentTypeOptions: string; contentSecurityPolicy: string } }> {
        await this.threadOrThrow(id);
        const rowId = parseAttachmentId(attachmentId);
        if (!rowId) throw httpError(404);
        const attachment = await this.attachments.read(id, rowId);
        if (!attachment) throw httpError(404);
        return {
            // `upload` only ever stores what `sniffImageType` returned.
            contentType: attachment.contentType as AttachmentImageType,
            body: attachment.bytes,
            headers: { xContentTypeOptions: X_CONTENT_TYPE_OPTIONS, contentSecurityPolicy: CONTENT_SECURITY_POLICY },
        };
    }

    private async threadOrThrow(id: string): Promise<void> {
        if (!(await this.threads.get(id))) throw httpError(404);
    }
}
