/**
 * Third of six in the context-provider slice (PROJECT.md, "Context providers"). `runner.card_context`
 * (card 0185) is where a snapshot lives; `ContextProvider`/`ContextProviderRegistry`/
 * `UrlContextProvider` (card 0186) is how one gets fetched. This is the seam between them: attaching a
 * document to a card, over HTTP.
 *
 * `fetchedAt` and `createdAt` are both `datetime` and are not redundant — see the migration's own
 * header comment (`data/migrations/20260902120000_card_context.sql`): `fetchedAt` is when the source
 * said the content was current, `createdAt` is when this row was written.
 * generated from [ContextSnapshot](file://./../../../../apps/api/data/contracts/context.ck#L22)
 */
export interface ContextSnapshot {
    id: string;
    sourceUrl: string;
    fetchedAt: string;
    fetchedBy: string;
    title?: string;
    content: string;
    contentHash: string;
    createdAt: string;
}

/**
 * `POST .../context`'s request: the URL to fetch, nothing else. `fetchedBy` is not a field here —
 * it is always `'human'` on this surface (this card's Constraints), never something a caller chooses.
 * generated from [AttachContextRequest](file://./../../../../apps/api/data/contracts/context.ck#L35)
 */
export interface AttachContextRequest {
    sourceUrl: string;
}
