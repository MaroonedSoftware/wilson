/**
 * An item a `CardSource` reports as changed since some cursor — enough to create or update a card's
 * descriptive fields, and nothing more. Per PROJECT.md's "Card sources" inbound-authority rule, a
 * source may report `title` and `body`; `stage`, `branch`, and `retries` stay the board's and are
 * deliberately not part of this shape.
 */
export type CardSourceItem = {
    /** The id this item is stored under in `cards.external`, keyed by this source's `name` — e.g.
     * `{ linear: 'ENG-123' }` (PROJECT.md). */
    readonly externalId: string;
    readonly title: string;
    readonly body: string;
};

/**
 * A source's report of what changed since `cursor` — `{ ok: true }` or a refusal naming why, never a
 * throw, shaped after `WebhookDestinationCheck` (`#modules/notify/webhook.destination.js`), the house
 * shape for "this failed, here is why".
 */
export type CardSourceFetchResult =
    | { readonly ok: true; readonly items: readonly CardSourceItem[] }
    | { readonly ok: false; readonly reason: string };

/**
 * A system cards can be created and updated from — Linear, GitHub Issues, email (PROJECT.md's "Card
 * sources"). `CardSourceRegistry` is the seam a poll or webhook route resolves one through by name;
 * nothing registers a source or calls the registry yet — the writer that would is a later card.
 *
 * Pure and inbound-authority-only: this interface reports what a source would say. It never writes
 * to the board, and it never carries `stage`, `branch`, or `retries` — those flow the other way, as a
 * status mirror, not through here.
 */
export interface CardSource {
    /** The key this source's refs are stored under in `cards.external`, e.g. `linear`. */
    readonly name: string;

    /** Items changed since `cursor` (`undefined` for "since the beginning"). Never throws. */
    changedSince(cursor: string | undefined): Promise<CardSourceFetchResult>;
}
