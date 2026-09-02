import { describe, expect, it } from 'vitest';
import type { CardSource, CardSourceItem } from '#modules/sources/card.source.js';

/** A stub `CardSource` that hands back a fixed set of items regardless of `cursor` — enough to prove
 * the interface's item shape round-trips, without a network call or a database. */
const stubSource = (items: readonly CardSourceItem[]): CardSource => ({
    name: 'stub',
    changedSince: async () => ({ ok: true, items }),
});

describe('CardSource', () => {
    it('round-trips the item shape: external id, title, and body', async () => {
        const item: CardSourceItem = { externalId: 'ENG-123', title: 'Fix the thing', body: 'It is broken.' };
        const source = stubSource([item]);

        const result = await source.changedSince(undefined);

        expect(result).toEqual({ ok: true, items: [item] });
    });

    it('reports its name as the key its refs are stored under', () => {
        const source = stubSource([]);

        expect(source.name).toBe('stub');
    });
});
