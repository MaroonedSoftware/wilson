/**
 * Outcome of a `ContextProvider.fetch` — a discriminated result, not a throw, because a dead host, a
 * timeout, a 404, an oversized body, a refused destination and a redirect are six things a person may
 * need told apart in the app (card 0186's Constraints: "Failures are ordinary outcomes, not
 * exceptions"). Shaped after `WebhookDestinationCheck` (`#modules/notify/webhook.destination.js`) —
 * the house shape for "this failed, here is why" — on purpose, so the two read the same way.
 *
 * The success branch carries exactly what the snapshot table stores, and nothing more: `title`
 * (optional — not every source has one), `content`, a `contentHash`, and `fetchedAt`. This is where
 * PROJECT.md's "Context providers" trimming rule — "store only message text, author display name,
 * timestamp — not emails, not account ids, not attachments" — is enforced, because a schema cannot
 * enforce it and must not pretend to (the snapshot-table card says so plainly). `contentHash` is a
 * sha256 hex digest computed by the provider itself, the only thing that ever holds the raw bytes, so
 * the retention card has a stable value to keep after the content it hashed has expired.
 */
export type ContextFetchResult =
    | {
          readonly ok: true;
          readonly title?: string;
          readonly content: string;
          readonly contentHash: string;
          readonly fetchedAt: Date;
      }
    | { readonly ok: false; readonly reason: string };

/**
 * A source `attach` can pull a card's planning context from — a Slack thread, a Notion page, a Linear
 * comment chain, a plain URL. `UrlContextProvider` is the one implementation today;
 * `ContextProviderRegistry` is the seam Slack, Notion and Linear plug into once each has its own card
 * (every one of them needs a credential this card deliberately does not have).
 *
 * Fetch-and-normalise only. Deliberately not here, per card 0186's Out of scope: storing what was
 * fetched (the snapshot-table card), the HTTP surface that calls this (the contract card, blocked on
 * both), and auto-attach (which needs card sources that do not exist yet).
 */
export interface ContextProvider {
    /** Whether this provider is the one to fetch `url` — the registry's dispatch key. Cheap and
     * synchronous: parsing/pattern-matching the URL, never a network call. */
    canHandle(url: string): boolean;

    /**
     * Fetch and normalise `url`. Never throws — every way this can fail (network, timeout, refused
     * destination, oversized body, non-2xx response, a redirect) comes back as `{ ok: false, reason }`
     * instead.
     */
    fetch(url: string): Promise<ContextFetchResult>;
}
