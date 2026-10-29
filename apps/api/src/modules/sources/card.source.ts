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
    /**
     * A source-supplied marker that changes when this item genuinely changes and stays fixed when
     * the exact same delivery repeats — card 0197's dedup key includes it precisely so two edits to
     * identical text still count as two deliveries, which content itself could never tell apart.
     * `GitHubIssuesSource` ([[0199]]) uses the issue's `updated_at`: GitHub bumps it on every edit and
     * holds it fixed on a pure redelivery.
     */
    readonly version: string;
    /**
     * Whether the ticket behind this item is closed upstream. A source has no authority over board
     * state (PROJECT.md's "Card sources" inbound-authority rule) — it only reports the fact, and
     * `InboundCardWriter` (card 0200) decides what a closure means for a matching card, or for one it
     * has never seen. `GitHubIssuesSource` ([[0199]]) fetches `state=all` rather than `state=open`
     * precisely so it can report this on every item, including the pull-request-filtered ones it
     * already drops.
     */
    readonly closed: boolean;
};

/**
 * A source's report of what changed since `cursor` — `{ ok: true }` or a refusal naming why, never a
 * throw, shaped after `WebhookDestinationCheck` (`#modules/notify/webhook.destination.js`), the house
 * shape for "this failed, here is why".
 *
 * The success branch carries `cursor` forward — the value the *next* `changedSince` call should be
 * handed, opaque to everything but the source that produced it (`wilson.source_cursors`'s own doc
 * comment: "a timestamp for one source, an ETag or an opaque page token for another"). Required, not
 * optional: a source answers "what changed, and where am I now" together, every time it succeeds,
 * even when `items` is empty — there is always a point to resume from, whether or not anything
 * actually changed since the last one. Card 0198's poller (`source.poller.ts`) is what actually
 * persists it, only on this branch and only once every reported item has been applied.
 */
export type CardSourceFetchResult =
    { readonly ok: true; readonly items: readonly CardSourceItem[]; readonly cursor: string } | { readonly ok: false; readonly reason: string };

/**
 * Which of the five human-meaningful transitions `StatusMirrorPoller` (`status.mirror.poller.ts`,
 * card 0201) reports back to a card's external ref. Its own type, not `NotifyMoment`
 * (`#modules/notify/notification.js`): that one describes a different audience — the operator, over a
 * webhook — and does not name `'started'` or `'dropped'`, the two moments that matter here and not
 * there.
 */
export type MirrorMoment = 'started' | 'ready' | 'merged' | 'dropped' | 'needs-human';

/**
 * What `StatusMirrorPoller` hands a source's `mirrorStatus` — enough for a source to compose its own
 * comment without reaching back into the board. `reason` is present only for the one moment that
 * carries one (`needs-human`), and — per this card's Constraints — a source must compose a short,
 * fixed sentence per moment rather than forward it verbatim: a `needsHuman` reason can name a file
 * path, a budget figure, or `source-closed` itself, none of which belongs on a potentially public
 * third-party surface.
 */
export type MirrorStatus = {
    readonly moment: MirrorMoment;
    readonly cardId: string;
    readonly title: string;
    readonly reason?: string;
};

/**
 * A system cards can be created and updated from — Linear, GitHub Issues, email (PROJECT.md's "Card
 * sources"). `CardSourceRegistry` is the seam a poll or webhook route resolves one through by name;
 * nothing registers a source or calls the registry yet — the writer that would is a later card.
 *
 * Pure and inbound-authority-only on `changedSince`: that method reports what a source would say, and
 * never carries `stage`, `branch`, or `retries` — those flow the other way, through `mirrorStatus`,
 * outward only, not through `changedSince`.
 */
export interface CardSource {
    /** The key this source's refs are stored under in `cards.external`, e.g. `linear`. */
    readonly name: string;

    /** Items changed since `cursor` (`undefined` for "since the beginning"). Never throws. */
    changedSince(cursor: string | undefined): Promise<CardSourceFetchResult>;

    /**
     * Card 0201. Report `status` — a card just reaching one of the five mirrored moments
     * (`MirrorMoment`) — to the ticket `externalId` names. Outward only: this is the one place in the
     * whole `CardSource` interface that writes to a third party rather than reading from one, and
     * nothing it returns is ever consulted for board state (PROJECT.md's "Card sources"
     * inbound-authority rule stays intact — this is the other half, "one-way authority with two-way
     * data").
     *
     * Optional: a source with no write access, or one that chooses not to support this, implements
     * nothing, and `StatusMirrorPoller` skips it. The same refusal shape as `changedSince` — `{ ok:
     * true }` or a named reason, never a throw — since a failed mirror must never unwind a transition
     * that already committed.
     */
    mirrorStatus?(externalId: string, status: MirrorStatus): Promise<{ ok: true } | { ok: false; reason: string }>;
}
