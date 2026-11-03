import { z } from 'zod';
import { DateTime } from 'luxon';

const _ZodBinary = z.custom<Buffer>(val => Buffer.isBuffer(val), { error: 'Must be binary data' });
const _ZodDatetime = z.preprocess(
    val => (typeof val === 'string' ? DateTime.fromISO(val) : val),
    z.custom<DateTime>(val => val instanceof DateTime && val.isValid, { message: 'Must be in ISO 8601 format' }),
);

/**
 * Third of six in the context-provider slice (PROJECT.md, "Context providers"). `wilson.card_context`
 * (card 0185) is where a snapshot lives; `ContextProvider`/`ContextProviderRegistry`/
 * `UrlContextProvider` (card 0186) is how one gets fetched. This is the seam between them: attaching a
 * document to a card, over HTTP.
 *
 * `fetchedAt` and `createdAt` are both `datetime` and are not redundant — see the migration's own
 * header comment (`data/migrations/20261029000500_board.sql`): `fetchedAt` is when the source
 * said the content was current, `createdAt` is when this row was written.
 * generated from [ContextSnapshot](../../data/contracts/context.ck)
 */
export const ContextSnapshot = z.strictObject({
    id: z.string(),
    sourceUrl: z.string(),
    fetchedAt: _ZodDatetime,
    fetchedBy: z.string(),
    title: z.string().optional(),
    content: z.string(),
    contentHash: z.string(),
    createdAt: _ZodDatetime,
});
export type ContextSnapshot = z.infer<typeof ContextSnapshot>;

/**
 * `POST .../context`'s request: the URL to fetch, nothing else. `fetchedBy` is not a field here —
 * it is always `'human'` on this surface (this card's Constraints), never something a caller chooses.
 * generated from [AttachContextRequest](../../data/contracts/context.ck)
 */
export const AttachContextRequest = z.strictObject({
    sourceUrl: z.string(),
});
export type AttachContextRequest = z.infer<typeof AttachContextRequest>;

/**
 * An image kept on a card (split from card 0006). Metadata only: the bytes are a `BYTEA` column on
 * `wilson.card_attachments`, for the reason that migration's header gives, and they are not in this
 * contract because a card at its 20 MB cap must still list as a small JSON response. One attachment's
 * bytes come from `GET .../attachments/{attachmentId}`. `contentType` is the type sniffed from the
 * bytes, never the one the uploader declared.
 * generated from [CardAttachment](../../data/contracts/context.ck)
 */
export const CardAttachment = z.strictObject({
    id: z.string(),
    filename: z.string(),
    contentType: z.string(),
    byteSize: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()),
    contentHash: z.string(),
    addedBy: z.string(),
    createdAt: _ZodDatetime,
});
export type CardAttachment = z.infer<typeof CardAttachment>;

/**
 * Documentation, not validation: a multipart body reaches `AttachmentService.attach` as the parser's
 * own `MultipartBody`, and the SDK types it as `FormData`, so nothing checks this shape.
 * generated from [AttachImageUpload](../../data/contracts/context.ck)
 */
export const AttachImageUpload = z.strictObject({
    file: _ZodBinary,
});
export type AttachImageUpload = z.infer<typeof AttachImageUpload>;
