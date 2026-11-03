import { createHash } from 'node:crypto';
import { basename } from 'node:path';

/** The largest single image, from card 0006's suggested figures. Separate from `MAX_CONTENT_BYTES`, which caps fetched text. */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/** The most images one card can hold, from card 0006's suggested figures. */
export const MAX_ATTACHMENTS_PER_CARD = 10;

/** The most image bytes one card can hold, from card 0006's suggested figures. Lower than ten images at the per-file cap, so this can trip first. */
export const MAX_ATTACHMENT_BYTES_PER_CARD = 20 * 1024 * 1024;

export type AttachmentImageType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

const startsWith = (bytes: Buffer, signature: number[], offset = 0): boolean =>
    bytes.length >= offset + signature.length && signature.every((byte, index) => bytes[offset + index] === byte);

/**
 * The image type `bytes` actually are, by magic bytes alone, or `undefined` for anything else.
 * SVG is not one of them: it is text a browser can execute, which is what the download route
 * promises never to serve.
 */
export const sniffImageType = (bytes: Buffer): AttachmentImageType | undefined => {
    if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
    if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
    if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
    if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
    return undefined;
};

/**
 * A name safe to display. It always starts with a letter or digit, not only a non-dot: a leading `-`
 * reads as a flag the moment someone passes the name to a command. An empty result becomes `image`.
 */
export const safeFilename = (raw: string): string =>
    basename(raw)
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .replace(/^[^A-Za-z0-9]+/, '')
        .slice(0, 120) || 'image';

const MAX_BIGINT = 9223372036854775807n;

/**
 * `attachmentId` as a row id, or `undefined` when no row could have it: canonical decimal only, so
 * `BigInt`'s other spellings (`0x10`, ` 7 `, `007`) miss rather than alias a real row, and in range
 * for Postgres, so a long number misses rather than failing the query.
 */
export const parseAttachmentId = (raw: string): string | undefined => {
    if (!/^[1-9][0-9]{0,18}$/.test(raw)) return undefined;
    return BigInt(raw) <= MAX_BIGINT ? raw : undefined;
};

/** A sha256 hex digest, the same call `UrlContextProvider` makes for fetched text. */
export const contentHash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
