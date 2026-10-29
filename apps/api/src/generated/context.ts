import { z } from 'zod';
import { DateTime } from 'luxon';

const _ZodDatetime = z.preprocess(
    val => (typeof val === 'string' ? DateTime.fromISO(val) : val),
    z.custom<DateTime>(val => val instanceof DateTime && val.isValid, { message: 'Must be in ISO 8601 format' }),
);

/**
 * Third of six in the context-provider slice (PROJECT.md, "Context providers"). `runner.card_context`
 * (card 0185) is where a snapshot lives; `ContextProvider`/`ContextProviderRegistry`/
 * `UrlContextProvider` (card 0186) is how one gets fetched. This is the seam between them: attaching a
 * document to a card, over HTTP.
 *
 * `fetchedAt` and `createdAt` are both `datetime` and are not redundant — see the migration's own
 * header comment (`data/migrations/20260902120000_card_context.sql`): `fetchedAt` is when the source
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
