import { describe, expect, it } from 'vitest';
import type { CardSource, CardSourceFetchResult, CardSourceItem } from '#modules/sources/card.source.js';

/** A stub `CardSource` that hands back a fixed set of items regardless of `cursor` — enough to prove
 * the interface's item shape round-trips, without a network call or a database. */
const stubSource = (items: readonly CardSourceItem[]): CardSource => ({
    name: 'stub',
    changedSince: async () => ({ ok: true, items }),
});

/** A stub `CardSource` that always refuses — proves the `{ ok: false; reason }` branch of
 * `CardSourceFetchResult` round-trips too, not just the success branch. */
const refusingSource = (reason: string): CardSource => ({
    name: 'stub',
    changedSince: async (): Promise<CardSourceFetchResult> => ({ ok: false, reason }),
});

describe('CardSource', () => {
    it('round-trips the item shape: external id, title, and body', async () => {
        const item: CardSourceItem = { externalId: 'ENG-123', title: 'Fix the thing', body: 'It is broken.' };
        const source = stubSource([item]);

        const result = await source.changedSince(undefined);

        expect(result).toEqual({ ok: true, items: [item] });
    });

    it('round-trips multiple items in a single fetch', async () => {
        const items: CardSourceItem[] = [
            { externalId: 'ENG-1', title: 'First', body: 'One' },
            { externalId: 'ENG-2', title: 'Second', body: 'Two' },
        ];
        const source = stubSource(items);

        const result = await source.changedSince(undefined);

        expect(result).toEqual({ ok: true, items });
    });

    it('reports its name as the key its refs are stored under', () => {
        const source = stubSource([]);

        expect(source.name).toBe('stub');
    });

    it('can refuse instead of reporting items, naming why', async () => {
        const source = refusingSource('upstream API returned 401');

        const result = await source.changedSince(undefined);

        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe('upstream API returned 401');
    });

    it('accepts a cursor and passes it through to changedSince without altering the result shape', async () => {
        let receivedCursor: string | undefined;
        const source: CardSource = {
            name: 'stub',
            changedSince: async (cursor) => {
                receivedCursor = cursor;
                return { ok: true, items: [] };
            },
        };

        await source.changedSince('cursor-42');

        expect(receivedCursor).toBe('cursor-42');
    });
});
