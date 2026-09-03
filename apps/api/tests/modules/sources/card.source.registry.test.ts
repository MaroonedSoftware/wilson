import { describe, expect, it } from 'vitest';
import { CardSourceRegistry } from '#modules/sources/card.source.registry.js';
import type { CardSource, CardSourceFetchResult } from '#modules/sources/card.source.js';

/** A minimal `CardSource` fake: reports `name` and never actually fetches — the registry's job is
 * dispatch by name, not fetching, so these tests never need `changedSince` to do anything. */
const fakeSource = (name: string): CardSource => ({
    name,
    changedSince: (): Promise<CardSourceFetchResult> => Promise.reject(new Error('not called by these tests')),
});

describe('CardSourceRegistry', () => {
    it('resolves a registered source by name', () => {
        const linear = fakeSource('linear');
        const registry = new CardSourceRegistry([linear]);

        const result = registry.resolve('linear');

        expect(result).toEqual({ ok: true, source: linear });
    });

    it('refuses an unknown name, naming what was asked for', () => {
        const registry = new CardSourceRegistry([fakeSource('linear')]);

        const result = registry.resolve('github');

        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toContain('github');
    });

    it('resolves the matching source when more than one is registered', () => {
        const linear = fakeSource('linear');
        const github = fakeSource('github');
        const registry = new CardSourceRegistry([linear, github]);

        const result = registry.resolve('github');

        expect(result).toEqual({ ok: true, source: github });
    });

    it('refuses when the registry has no sources at all', () => {
        const registry = new CardSourceRegistry([]);

        const result = registry.resolve('linear');

        expect(result.ok).toBe(false);
    });

    it('treats the name as case-sensitive and exact, not a prefix or substring match', () => {
        const registry = new CardSourceRegistry([fakeSource('linear')]);

        const result = registry.resolve('Linear');

        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toContain('Linear');
    });

    it('resolves the first source when two are registered under the same name', () => {
        const first = fakeSource('linear');
        const second = fakeSource('linear');
        const registry = new CardSourceRegistry([first, second]);

        const result = registry.resolve('linear');

        expect(result).toEqual({ ok: true, source: first });
    });

    describe('list', () => {
        it('returns every registered source, in registration order', () => {
            const linear = fakeSource('linear');
            const github = fakeSource('github');
            const registry = new CardSourceRegistry([linear, github]);

            expect(registry.list()).toEqual([linear, github]);
        });

        it('returns an empty list when constructed with no sources — the intended state until a source registers ([[0199]])', () => {
            const registry = new CardSourceRegistry([]);

            expect(registry.list()).toEqual([]);
        });
    });
});
