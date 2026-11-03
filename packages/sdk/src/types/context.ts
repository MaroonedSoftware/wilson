import { DateTime } from 'luxon';
const __dt = (v: unknown, path: string): DateTime => {
    if (typeof v !== 'string') {
        throw new TypeError(`ContractKit: expected an ISO 8601 string at '${path}', received ${typeof v}.`);
    }
    const d = DateTime.fromISO(v);
    if (!d.isValid) throw new TypeError(`ContractKit: '${v}' at '${path}' is not a valid ISO 8601 datetime.`);
    return d;
};

/**
 * Third of six in the context-provider slice (PROJECT.md, "Context providers"). `wilson.card_context`
 * (card 0185) is where a snapshot lives; `ContextProvider`/`ContextProviderRegistry`/
 * `UrlContextProvider` (card 0186) is how one gets fetched. This is the seam between them: attaching a
 * document to a card, over HTTP.
 *
 * `fetchedAt` and `createdAt` are both `datetime` and are not redundant — see the migration's own
 * header comment (`data/migrations/20261029000500_board.sql`): `fetchedAt` is when the source
 * said the content was current, `createdAt` is when this row was written.
 * generated from [ContextSnapshot](../../../../apps/api/data/contracts/context.ck)
 */
export interface ContextSnapshot {
    id: string;
    sourceUrl: string;
    fetchedAt: DateTime;
    fetchedBy: string;
    title?: string;
    content: string;
    contentHash: string;
    createdAt: DateTime;
}

/** Rehydrates every wire-encoded scalar in a ContextSnapshot into its runtime type. Mutates and returns `raw`. */
export function reviveContextSnapshot(raw: ContextSnapshot): ContextSnapshot {
    const __o0 = raw as unknown as Record<string, unknown>;
    __o0['fetchedAt'] = __dt(__o0['fetchedAt'], 'ContextSnapshot.fetchedAt');
    __o0['createdAt'] = __dt(__o0['createdAt'], 'ContextSnapshot.createdAt');
    return raw;
}

/**
 * `POST .../context`'s request: the URL to fetch, nothing else. `fetchedBy` is not a field here —
 * it is always `'human'` on this surface (this card's Constraints), never something a caller chooses.
 * generated from [AttachContextRequest](../../../../apps/api/data/contracts/context.ck)
 */
export interface AttachContextRequest {
    sourceUrl: string;
}

/**
 * An image kept on a card (split from card 0006). Metadata only: the bytes are a `BYTEA` column on
 * `wilson.card_attachments`, for the reason that migration's header gives, and they are not in this
 * contract because a card at its 20 MB cap must still list as a small JSON response. One attachment's
 * bytes come from `GET .../attachments/{attachmentId}`. `contentType` is the type sniffed from the
 * bytes, never the one the uploader declared.
 * generated from [CardAttachment](../../../../apps/api/data/contracts/context.ck)
 */
export interface CardAttachment {
    id: string;
    filename: string;
    contentType: string;
    byteSize: number;
    contentHash: string;
    addedBy: string;
    createdAt: DateTime;
}

/** Rehydrates every wire-encoded scalar in a CardAttachment into its runtime type. Mutates and returns `raw`. */
export function reviveCardAttachment(raw: CardAttachment): CardAttachment {
    const __o0 = raw as unknown as Record<string, unknown>;
    __o0['createdAt'] = __dt(__o0['createdAt'], 'CardAttachment.createdAt');
    return raw;
}

/**
 * Documentation, not validation: a multipart body reaches `AttachmentService.attach` as the parser's
 * own `MultipartBody`, and the SDK types it as `FormData`, so nothing checks this shape.
 * generated from [AttachImageUpload](../../../../apps/api/data/contracts/context.ck)
 */
export interface AttachImageUpload {
    file: Blob;
}
