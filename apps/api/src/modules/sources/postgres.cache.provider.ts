import { Kysely, sql } from 'kysely';
import type { DateTime, Duration } from 'luxon';
import { CacheProvider } from '@maroonedsoftware/cache';
import type { DB } from '#modules/data/db.js';

/**
 * Postgres's own clock, typed as `DateTime` (what `expiresAt` reads back as, per `db.ts`'s own note
 * on `KyselyPgTypeOverrides`) so it satisfies whichever `WhereInterface` — a plain `where` or an
 * `onConflict` update's — asks for it. Every comparison this class makes (`get`'s freshness check,
 * `update`'s, and `add`'s atomic claim below) resolves against this, never this process's own clock,
 * which is what keeps them consistent across however many instances of this class are running.
 */
const now = () => sql<DateTime>`now()`;

/**
 * `expiresAt` for a write carrying `ttl` — computed by Postgres itself (`now() + make_interval(...)`)
 * rather than this process, for the same reason `now()` above is. `make_interval`'s `secs` parameter
 * accepts a fraction, so no rounding or clamping is needed the way `IoRedisCacheProvider`'s `EX`
 * (integer-only) requires.
 */
const expiresAtFor = (ttl: Duration) => sql<string>`now() + make_interval(secs => ${ttl.as('seconds')})`;

/** Postgres's own "never" for a `timestamptz` column — used for a write with no `ttl` at all, so
 * `wilson.cache_entries.expires_at` (`NOT NULL`, card 0197's own migration) never needs a nullable
 * column just to say "does not expire". Compares correctly against `now()` in every direction. */
const NEVER = sql<string>`'infinity'`;

/**
 * `CacheProvider` (`@maroonedsoftware/cache`) against `wilson.cache_entries` — this deployment's
 * Postgres-only stand-in for the package's only shipped backend, `IoRedisCacheProvider`, which this
 * card's Constraints rule out (no Redis service, no client dependency, and adding one for this alone
 * is out of proportion). Follows `SourceCursorRepository`'s own reasoning for writing a repository
 * against a table that was already there, one level over.
 *
 * `key` is `wilson.cache_entries`'s primary key, so every write below is a plain `WHERE key = ?`
 * (or, for `add`, an `ON CONFLICT (key)`) — this class knows nothing about what a key means; that is
 * `CacheIdempotencyStore`'s (and, above it, `InboundCardWriter`'s) business.
 */
export class PostgresCacheProvider implements CacheProvider {
    constructor(private readonly db: Kysely<DB>) {}

    /** An unexpired row's value, or `null` — for a missing key exactly as for an expired one, per
     * `CacheProvider`'s own contract: a row this deployment never sweeps must never read back as
     * live data. */
    async get(key: string): Promise<string | null> {
        const row = await this.db
            .selectFrom('wilson.cacheEntries')
            .select('value')
            .where('key', '=', key)
            .where('expiresAt', '>', now())
            .executeTakeFirst();
        return row?.value ?? null;
    }

    /** Unconditional upsert: whatever the previous state of `key` — absent, live, or expired — this
     * always writes, and always sets the given `ttl`. */
    async set(key: string, value: string, ttl: Duration): Promise<void> {
        const expiresAt = expiresAtFor(ttl);
        await this.db
            .insertInto('wilson.cacheEntries')
            .values({ key, value, expiresAt })
            .onConflict(oc => oc.column('key').doUpdateSet({ value, expiresAt }))
            .execute();
    }

    /**
     * Atomic set-if-absent: one statement, not a read then a write, so two racing callers for the
     * same `key` cannot both see "absent". `ON CONFLICT ... DO UPDATE ... WHERE` is the shape — an
     * expired row is claimable exactly like a missing one, refused (no row written, no row returned)
     * only when an unexpired entry already holds `key`. `RETURNING key` is how the caller tells the
     * two apart: a row back means this call won the claim.
     */
    async add(key: string, value: string, options?: { ttl?: Duration }): Promise<boolean> {
        const expiresAt = options?.ttl ? expiresAtFor(options.ttl) : NEVER;
        const claimed = await this.db
            .insertInto('wilson.cacheEntries')
            .values({ key, value, expiresAt })
            .onConflict(oc => oc.column('key').doUpdateSet({ value, expiresAt }).where('wilson.cacheEntries.expiresAt', '<=', now()))
            .returning('key')
            .executeTakeFirst();
        return claimed !== undefined;
    }

    /** Overwrites an existing, unexpired entry's value; an absent or already-expired `key` is left
     * untouched — `CacheProvider`'s own contract that `update` must never resurrect an expired key.
     * Omitting `ttl` preserves the row's current `expiresAt` by simply not naming that column in the
     * `SET` clause. */
    async update(key: string, value: string, ttl?: Duration): Promise<void> {
        await this.db
            .updateTable('wilson.cacheEntries')
            .set(ttl ? { value, expiresAt: expiresAtFor(ttl) } : { value })
            .where('key', '=', key)
            .where('expiresAt', '>', now())
            .execute();
    }

    /** Removes `key` regardless of whether it has expired, returning the key that was deleted, or
     * `null` if it was already absent — `CacheProvider.delete`'s own contract. A set stored under
     * `key` goes too, as Redis's `DEL` removes a key whatever its type. Both deletes are one
     * statement, so no reader sees one half gone. */
    async delete(key: string): Promise<string | null> {
        const row = await this.db
            .with('entry', db => db.deleteFrom('wilson.cacheEntries').where('key', '=', key).returning('key'))
            .with('members', db => db.deleteFrom('wilson.cacheSetMembers').where('key', '=', key).returning('key'))
            .selectNoFrom(eb => [
                eb.or([eb.exists(eb.selectFrom('entry').select('key')), eb.exists(eb.selectFrom('members').select('key'))]).as('deleted'),
            ])
            .executeTakeFirstOrThrow();
        return row.deleted ? key : null;
    }

    /** Get-and-delete in one statement, so two racing callers for a single-use entry (a one-time
     * code, a pending challenge) cannot both receive it. An expired row reads as absent and is left
     * where it is, as `get` leaves it. */
    async take(key: string): Promise<string | null> {
        const row = await this.db
            .deleteFrom('wilson.cacheEntries')
            .where('key', '=', key)
            .where('expiresAt', '>', now())
            .returning('value')
            .executeTakeFirst();
        return row?.value ?? null;
    }

    /**
     * Adds `member` to the set at `key`, returning whether it was not already there.
     *
     * One statement. It reads the set's current deadline (the latest live row's), works out the new
     * one, moves every live member to it, and inserts `member` at it. With a `ttl` the new deadline
     * is the later of the current one and `now() + ttl`, so a write never shortens a set's life.
     * Without one it keeps the current deadline, or never expires for a set that does not exist yet.
     * That is `IoRedisCacheProvider`'s `SADD` plus conditional `EXPIRE`. A member whose row has
     * expired is absent, so re-adding it counts as an add.
     */
    async setAdd(key: string, member: string, options?: { ttl?: Duration }): Promise<boolean> {
        const deadline = options?.ttl
            ? sql<DateTime>`greatest(live.expires_at, ${expiresAtFor(options.ttl)})`
            : sql<DateTime>`coalesce(live.expires_at, ${NEVER})`;
        const result = await sql<{ added: boolean }>`
            WITH live AS (
                SELECT max(expires_at) AS expires_at FROM wilson.cache_set_members
                WHERE key = ${key} AND expires_at > now()
            ), target AS (
                SELECT ${deadline} AS expires_at FROM live
            ), extended AS (
                UPDATE wilson.cache_set_members m SET expires_at = target.expires_at FROM target
                WHERE m.key = ${key} AND m.expires_at > now() AND m.expires_at < target.expires_at
            ), added AS (
                INSERT INTO wilson.cache_set_members (key, member, expires_at)
                SELECT ${key}, ${member}, target.expires_at FROM target
                ON CONFLICT (key, member) DO UPDATE SET expires_at = excluded.expires_at
                WHERE wilson.cache_set_members.expires_at <= now()
                RETURNING 1
            )
            SELECT EXISTS (SELECT 1 FROM added) AS added
        `.execute(this.db);
        return result.rows[0]?.added ?? false;
    }

    /** Removes `member` from the set at `key`, returning whether it was there. An expired member
     * was not there. */
    async setRemove(key: string, member: string): Promise<boolean> {
        const row = await this.db
            .deleteFrom('wilson.cacheSetMembers')
            .where('key', '=', key)
            .where('member', '=', member)
            .where('expiresAt', '>', now())
            .returning('member')
            .executeTakeFirst();
        return row !== undefined;
    }

    /** Every live member of the set at `key`, in no particular order; empty for an absent or
     * expired set. */
    async setMembers(key: string): Promise<string[]> {
        const rows = await this.db
            .selectFrom('wilson.cacheSetMembers')
            .select('member')
            .where('key', '=', key)
            .where('expiresAt', '>', now())
            .execute();
        return rows.map(row => row.member);
    }
}
