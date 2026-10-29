import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, type Kysely } from 'kysely';
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

/** A `wilson.cache_entries.key` no other test uses — the same reasoning `uniqueProject` gives
 * (`test.db.ts`) for why cryptographic randomness, not a module counter, is what makes two calls
 * collide only by 128-bit accident regardless of which files vitest loads into which worker. */
const uniqueKey = (): string => `test-cache-key-${randomUUID()}`;

/** Inserts a row directly, bypassing `PostgresCacheProvider` entirely — the only way to put an
 * already-expired row in the table, since every one of the class's own writes computes `expiresAt`
 * in the future off a `ttl`. */
const insertRow = async (key: string, value: string, expiresAt: DateTime): Promise<void> => {
    await db.insertInto('wilson.cacheEntries').values({ key, value, expiresAt: expiresAt.toISO()! }).execute();
};

const expiresAtOf = async (key: string): Promise<DateTime> => {
    const row = await db.selectFrom('wilson.cacheEntries').select('expiresAt').where('key', '=', key).executeTakeFirstOrThrow();
    return row.expiresAt;
};

const rawValueOf = async (key: string): Promise<string | undefined> => {
    const row = await db.selectFrom('wilson.cacheEntries').select('value').where('key', '=', key).executeTakeFirst();
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

    it('removes a set stored under the key, as Redis DEL removes a key of any type', async () => {
        const provider = new PostgresCacheProvider(db);
        const key = uniqueKey();
        await provider.setAdd(key, 'a', { ttl: SHORT_TTL });

        expect(await provider.delete(key)).toBe(key);
        expect(await provider.setMembers(key)).toEqual([]);
    });
});

describe('PostgresCacheProvider.take', () => {
    it('returns a live value and removes it', async () => {
        const provider = new PostgresCacheProvider(db);
        const key = uniqueKey();
        await provider.set(key, 'once', SHORT_TTL);

        expect(await provider.take(key)).toBe('once');
        expect(await provider.get(key)).toBeNull();
    });

    it('returns null for an absent key', async () => {
        const provider = new PostgresCacheProvider(db);

        expect(await provider.take(uniqueKey())).toBeNull();
    });

    it('returns null for an expired key rather than handing back stale data', async () => {
        const provider = new PostgresCacheProvider(db);
        const key = uniqueKey();
        await insertRow(key, 'stale', PAST);

        expect(await provider.take(key)).toBeNull();
    });

    /** What `take` is for: a one-time code redeemed twice at once must be redeemed once. */
    it('hands the value to exactly one of two concurrent callers', async () => {
        const provider = new PostgresCacheProvider(db);
        const key = uniqueKey();
        await provider.set(key, 'once', SHORT_TTL);

        const results = await Promise.all([provider.take(key), provider.take(key)]);

        expect(results.filter(result => result === 'once')).toHaveLength(1);
        expect(results.filter(result => result === null)).toHaveLength(1);
    });
});

/** Inserts a set member directly, the only way to put an already-expired one in the table. */
const insertMember = async (key: string, member: string, expiresAt: DateTime): Promise<void> => {
    await db.insertInto('wilson.cacheSetMembers').values({ key, member, expiresAt: expiresAt.toISO()! }).execute();
};

const memberExpiries = async (key: string): Promise<number[]> => {
    const rows = await db
        .selectFrom('wilson.cacheSetMembers')
        .select('expiresAt')
        .where('key', '=', key)
        .where('expiresAt', '>', DateTime.now().toISO()!)
        .execute();
    return rows.map(row => row.expiresAt.toMillis());
};

describe('PostgresCacheProvider.setAdd', () => {
    it('adds a new member, returning true, and it reads back', async () => {
        const provider = new PostgresCacheProvider(db);
        const key = uniqueKey();

        expect(await provider.setAdd(key, 'a', { ttl: SHORT_TTL })).toBe(true);
        expect(await provider.setMembers(key)).toEqual(['a']);
    });

    it('returns false for a member already present and keeps one copy', async () => {
        const provider = new PostgresCacheProvider(db);
        const key = uniqueKey();
        await provider.setAdd(key, 'a', { ttl: SHORT_TTL });

        expect(await provider.setAdd(key, 'a', { ttl: SHORT_TTL })).toBe(false);
        expect(await provider.setMembers(key)).toEqual(['a']);
    });

    it('counts re-adding an expired member as an add', async () => {
        const provider = new PostgresCacheProvider(db);
        const key = uniqueKey();
        await insertMember(key, 'a', PAST);

        expect(await provider.setAdd(key, 'a', { ttl: SHORT_TTL })).toBe(true);
        expect(await provider.setMembers(key)).toEqual(['a']);
    });

    it('extends every live member to the longer ttl, so the set shares one deadline', async () => {
        const provider = new PostgresCacheProvider(db);
        const key = uniqueKey();
        await provider.setAdd(key, 'a', { ttl: SHORT_TTL });

        await provider.setAdd(key, 'b', { ttl: Duration.fromObject({ hours: 5 }) });

        const [first, second] = await memberExpiries(key);
        expect(first).toBe(second);
        expect(first).toBeGreaterThan(DateTime.now().plus({ hours: 4 }).toMillis());
    });

    it('never shortens the set: a shorter ttl leaves the existing deadline', async () => {
        const provider = new PostgresCacheProvider(db);
        const key = uniqueKey();
        await provider.setAdd(key, 'a', { ttl: Duration.fromObject({ hours: 5 }) });

        await provider.setAdd(key, 'b', { ttl: SHORT_TTL });

        const [first, second] = await memberExpiries(key);
        expect(first).toBe(second);
        expect(first).toBeGreaterThan(DateTime.now().plus({ hours: 4 }).toMillis());
    });

    it('keeps the current deadline when no ttl is given', async () => {
        const provider = new PostgresCacheProvider(db);
        const key = uniqueKey();
        await provider.setAdd(key, 'a', { ttl: SHORT_TTL });
        const [before] = await memberExpiries(key);

        await provider.setAdd(key, 'b');

        expect(await memberExpiries(key)).toEqual([before, before]);
    });

    it('never expires a set created without a ttl', async () => {
        const provider = new PostgresCacheProvider(db);
        const key = uniqueKey();

        await provider.setAdd(key, 'a');

        const { rows } = await sql<{ never: boolean }>`
            SELECT expires_at = 'infinity' AS never FROM wilson.cache_set_members WHERE key = ${key}
        `.execute(db);
        expect(rows).toEqual([{ never: true }]);
    });

    /** Why a set is rows: two sign-ins at once each add a session, and neither may be lost. */
    it('keeps both members of two concurrent adds to one set', async () => {
        const provider = new PostgresCacheProvider(db);
        const key = uniqueKey();

        const results = await Promise.all([provider.setAdd(key, 'a', { ttl: SHORT_TTL }), provider.setAdd(key, 'b', { ttl: SHORT_TTL })]);

        expect(results).toEqual([true, true]);
        expect((await provider.setMembers(key)).sort()).toEqual(['a', 'b']);
    });
});

describe('PostgresCacheProvider.setRemove', () => {
    it('removes a present member, returning true, and leaves the others', async () => {
        const provider = new PostgresCacheProvider(db);
        const key = uniqueKey();
        await provider.setAdd(key, 'a', { ttl: SHORT_TTL });
        await provider.setAdd(key, 'b', { ttl: SHORT_TTL });

        expect(await provider.setRemove(key, 'a')).toBe(true);
        expect(await provider.setMembers(key)).toEqual(['b']);
    });

    it('returns false for a member that is not there', async () => {
        const provider = new PostgresCacheProvider(db);

        expect(await provider.setRemove(uniqueKey(), 'a')).toBe(false);
    });

    it('returns false for a member that has expired', async () => {
        const provider = new PostgresCacheProvider(db);
        const key = uniqueKey();
        await insertMember(key, 'a', PAST);

        expect(await provider.setRemove(key, 'a')).toBe(false);
    });
});

describe('PostgresCacheProvider.setMembers', () => {
    it('is empty for a set that was never written', async () => {
        const provider = new PostgresCacheProvider(db);

        expect(await provider.setMembers(uniqueKey())).toEqual([]);
    });

    it('leaves out expired members', async () => {
        const provider = new PostgresCacheProvider(db);
        const key = uniqueKey();
        await insertMember(key, 'stale', PAST);
        await provider.setAdd(key, 'live', { ttl: SHORT_TTL });

        expect(await provider.setMembers(key)).toEqual(['live']);
    });
});
