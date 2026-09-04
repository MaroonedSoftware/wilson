import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { DateTime, Duration } from 'luxon';
import { PostgresCacheProvider } from '#modules/sources/postgres.cache.provider.js';
import { testDb } from '#tests/support/test.db.js';
import type { DB } from '#modules/data/db.js';

let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

/** A `runner.cache_entries.key` no other test uses — the same reasoning `uniqueProject` gives
 * (`test.db.ts`) for why cryptographic randomness, not a module counter, is what makes two calls
 * collide only by 128-bit accident regardless of which files vitest loads into which worker. */
const uniqueKey = (): string => `test-cache-key-${randomUUID()}`;

/** Inserts a row directly, bypassing `PostgresCacheProvider` entirely — the only way to put an
 * already-expired row in the table, since every one of the class's own writes computes `expiresAt`
 * in the future off a `ttl`. */
const insertRow = async (key: string, value: string, expiresAt: DateTime): Promise<void> => {
    await db.insertInto('runner.cacheEntries').values({ key, value, expiresAt: expiresAt.toISO()! }).execute();
};

const expiresAtOf = async (key: string): Promise<DateTime> => {
    const row = await db.selectFrom('runner.cacheEntries').select('expiresAt').where('key', '=', key).executeTakeFirstOrThrow();
    return row.expiresAt;
};

const rawValueOf = async (key: string): Promise<string | undefined> => {
    const row = await db.selectFrom('runner.cacheEntries').select('value').where('key', '=', key).executeTakeFirst();
    return row?.value;
};

const PAST = DateTime.now().minus({ minutes: 5 });
const SHORT_TTL = Duration.fromObject({ minutes: 10 });

describe('PostgresCacheProvider.get', () => {
    it('reports null for a key that has never been written', async () => {
        const provider = new PostgresCacheProvider(db);

        expect(await provider.get(uniqueKey())).toBeNull();
    });

    it('reads back exactly what set wrote', async () => {
        const provider = new PostgresCacheProvider(db);
        const key = uniqueKey();

        await provider.set(key, 'hello', SHORT_TTL);

        expect(await provider.get(key)).toBe('hello');
    });

    it('treats an expired row as absent rather than surfacing it as live data', async () => {
        const provider = new PostgresCacheProvider(db);
        const key = uniqueKey();
        await insertRow(key, 'stale', PAST);

        expect(await provider.get(key)).toBeNull();
    });
});

describe('PostgresCacheProvider.set', () => {
    it('creates a fresh key that did not exist before', async () => {
        const provider = new PostgresCacheProvider(db);
        const key = uniqueKey();

        await provider.set(key, 'v1', SHORT_TTL);

        expect(await provider.get(key)).toBe('v1');
    });

    it('overwrites a live entry, unconditionally', async () => {
        const provider = new PostgresCacheProvider(db);
        const key = uniqueKey();
        await provider.set(key, 'v1', SHORT_TTL);

        await provider.set(key, 'v2', SHORT_TTL);

        expect(await provider.get(key)).toBe('v2');
    });

    it('overwrites an already-expired entry, reviving it as live', async () => {
        const provider = new PostgresCacheProvider(db);
        const key = uniqueKey();
        await insertRow(key, 'stale', PAST);

        await provider.set(key, 'fresh', SHORT_TTL);

        expect(await provider.get(key)).toBe('fresh');
    });
});

describe('PostgresCacheProvider.add', () => {
    it('claims an absent key, returning true, and the value reads back', async () => {
        const provider = new PostgresCacheProvider(db);
        const key = uniqueKey();

        const claimed = await provider.add(key, 'v1', { ttl: SHORT_TTL });

        expect(claimed).toBe(true);
        expect(await provider.get(key)).toBe('v1');
    });

    it('refuses a key an unexpired entry already holds, returning false and leaving the value untouched', async () => {
        const provider = new PostgresCacheProvider(db);
        const key = uniqueKey();
        await provider.add(key, 'first', { ttl: SHORT_TTL });

        const claimed = await provider.add(key, 'second', { ttl: SHORT_TTL });

        expect(claimed).toBe(false);
        expect(await provider.get(key)).toBe('first');
    });

    it('claims a key an expired entry holds exactly like an absent one', async () => {
        const provider = new PostgresCacheProvider(db);
        const key = uniqueKey();
        await insertRow(key, 'stale', PAST);

        const claimed = await provider.add(key, 'fresh', { ttl: SHORT_TTL });

        expect(claimed).toBe(true);
        expect(await provider.get(key)).toBe('fresh');
    });

    /**
     * The acceptance criterion this card exists to satisfy: two racing callers for the same key must
     * not both see "absent" — one atomic statement, not a read then a write. Run concurrently, not
     * sequentially, so a naive read-then-write implementation would actually be exercised into
     * double-claiming.
     */
    it('resolves exactly one true and one false for two concurrent claims of the same key', async () => {
        const provider = new PostgresCacheProvider(db);
        const key = uniqueKey();

        const [a, b] = await Promise.all([provider.add(key, 'first', { ttl: SHORT_TTL }), provider.add(key, 'second', { ttl: SHORT_TTL })]);

        expect([a, b].filter(result => result === true)).toHaveLength(1);
        expect([a, b].filter(result => result === false)).toHaveLength(1);
    });
});

describe('PostgresCacheProvider.update', () => {
    it('overwrites the value of a live entry', async () => {
        const provider = new PostgresCacheProvider(db);
        const key = uniqueKey();
        await provider.set(key, 'v1', SHORT_TTL);

        await provider.update(key, 'v2');

        expect(await provider.get(key)).toBe('v2');
    });

    it('preserves the existing expiresAt exactly when no new ttl is given', async () => {
        const provider = new PostgresCacheProvider(db);
        const key = uniqueKey();
        await provider.set(key, 'v1', SHORT_TTL);
        const before = await expiresAtOf(key);

        await provider.update(key, 'v2');

        const after = await expiresAtOf(key);
        expect(after.toMillis()).toBe(before.toMillis());
    });

    it('resets expiresAt when a new ttl is given', async () => {
        const provider = new PostgresCacheProvider(db);
        const key = uniqueKey();
        await provider.set(key, 'v1', SHORT_TTL);
        const before = await expiresAtOf(key);

        await provider.update(key, 'v2', Duration.fromObject({ hours: 5 }));

        const after = await expiresAtOf(key);
        expect(after.toMillis()).toBeGreaterThan(before.toMillis());
    });

    it('is a no-op on a key that does not exist', async () => {
        const provider = new PostgresCacheProvider(db);
        const key = uniqueKey();

        await expect(provider.update(key, 'v1')).resolves.toBeUndefined();

        expect(await provider.get(key)).toBeNull();
    });

    it('does not resurrect an expired key: the stored value is left exactly as it was', async () => {
        const provider = new PostgresCacheProvider(db);
        const key = uniqueKey();
        await insertRow(key, 'stale', PAST);

        await provider.update(key, 'should-not-apply');

        expect(await rawValueOf(key)).toBe('stale');
        expect(await provider.get(key)).toBeNull();
    });
});

describe('PostgresCacheProvider.delete', () => {
    it('removes an existing key and returns it', async () => {
        const provider = new PostgresCacheProvider(db);
        const key = uniqueKey();
        await provider.set(key, 'v1', SHORT_TTL);

        expect(await provider.delete(key)).toBe(key);
        expect(await provider.get(key)).toBeNull();
    });

    it('returns null for a key that was never present', async () => {
        const provider = new PostgresCacheProvider(db);

        expect(await provider.delete(uniqueKey())).toBeNull();
    });

    it('removes an already-expired row too, rather than requiring a background sweep', async () => {
        const provider = new PostgresCacheProvider(db);
        const key = uniqueKey();
        await insertRow(key, 'stale', PAST);

        expect(await provider.delete(key)).toBe(key);
        expect(await rawValueOf(key)).toBeUndefined();
    });
});
