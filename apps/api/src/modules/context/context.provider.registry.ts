import type { ContextProvider } from './context.provider.js';

/** Which `ContextProvider` handles a URL, or why none of them do. Shaped after
 * `WebhookDestinationCheck` — a refusal names the reason rather than leaving the caller to guess. */
export type ContextProviderResolution = { readonly ok: true; readonly provider: ContextProvider } | { readonly ok: false; readonly reason: string };

/**
 * Resolves a URL to the first registered `ContextProvider` whose `canHandle` returns true.
 *
 * One provider is registered today (`UrlContextProvider`); the value of this class is the seam Slack,
 * Notion and Linear plug into once each has its own card, not the dispatch logic, which is
 * deliberately a linear scan through an ordered list rather than anything cleverer — with a handful of
 * providers, first-match-wins is the whole feature.
 */
export class ContextProviderRegistry {
    constructor(private readonly providers: readonly ContextProvider[]) {}

    resolve(url: string): ContextProviderResolution {
        const provider = this.providers.find(candidate => candidate.canHandle(url));
        if (!provider) {
            return { ok: false, reason: `no context provider handles "${url}"` };
        }
        return { ok: true, provider };
    }
}
