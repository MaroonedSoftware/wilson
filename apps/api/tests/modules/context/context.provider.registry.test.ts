import { describe, expect, it } from 'vitest';
import { ContextProviderRegistry } from '#modules/context/context.provider.registry.js';
import type { ContextFetchResult, ContextProvider } from '#modules/context/context.provider.js';

/** A minimal `ContextProvider` fake: handles URLs starting with `prefix`, and never actually fetches
 * — the registry's job is dispatch, not fetching, so these tests never need `fetch` to do anything. */
const fakeProvider = (prefix: string): ContextProvider => ({
    canHandle: (url: string) => url.startsWith(prefix),
    fetch: (): Promise<ContextFetchResult> => Promise.reject(new Error('not called by these tests')),
});

describe('ContextProviderRegistry', () => {
    it('resolves a handled URL to the provider whose canHandle returned true', () => {
        const urlProvider = fakeProvider('https://');
        const registry = new ContextProviderRegistry([urlProvider]);

        const result = registry.resolve('https://example.com/doc');

        expect(result).toEqual({ ok: true, provider: urlProvider });
    });

    it('refuses a URL no registered provider handles, naming that nothing handles it', () => {
        const registry = new ContextProviderRegistry([fakeProvider('https://')]);

        const result = registry.resolve('slack://workspace/thread');

        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toContain('slack://workspace/thread');
    });

    it('resolves to the first matching provider when more than one could handle a URL', () => {
        const first = fakeProvider('https://example.com');
        const second = fakeProvider('https://');
        const registry = new ContextProviderRegistry([first, second]);

        const result = registry.resolve('https://example.com/doc');

        expect(result).toEqual({ ok: true, provider: first });
    });

    it('refuses when the registry has no providers at all', () => {
        const registry = new ContextProviderRegistry([]);

        const result = registry.resolve('https://example.com/doc');

        expect(result.ok).toBe(false);
    });
});
