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
