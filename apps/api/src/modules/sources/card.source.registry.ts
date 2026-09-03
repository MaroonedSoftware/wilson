import type { CardSource } from './card.source.js';

/** Which `CardSource` handles `name`, or why none does. Shaped after `ContextProviderResolution`
 * (`#modules/context/context.provider.registry.js`) — a refusal names the reason rather than leaving
 * the caller to guess. */
export type CardSourceResolution = { readonly ok: true; readonly source: CardSource } | { readonly ok: false; readonly reason: string };

/**
 * Resolves a `CardSource` by the `name` its refs are stored under in `cards.external` (`{ linear:
 * 'ENG-123' }` — PROJECT.md's "Card sources"). Constructed with the list of sources rather than
 * resolving through the container, because nothing registers a source yet — per this card's
 * Constraints, "a mechanism with no consumer is the intended end state".
 *
 * Follows `ContextProviderRegistry` (`#modules/context/context.provider.registry.js`) one level over:
 * same resolve-or-refuse-with-a-reason shape, except dispatch is by exact `name` rather than a
 * predicate — a `CardSource` is looked up by the key already recorded on the card, not matched
 * against arbitrary input the way a URL is matched against `canHandle`.
 */
export class CardSourceRegistry {
    constructor(private readonly sources: readonly CardSource[]) {}

    resolve(name: string): CardSourceResolution {
        const source = this.sources.find(candidate => candidate.name === name);
        if (!source) {
            return { ok: false, reason: `no card source registered for "${name}"` };
        }
        return { ok: true, source };
    }
}
