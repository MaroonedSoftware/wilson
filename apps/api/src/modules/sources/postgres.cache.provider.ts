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
 * `runner.cache_entries.expires_at` (`NOT NULL`, card 0197's own migration) never needs a nullable
 * column just to say "does not expire". Compares correctly against `now()` in every direction. */
const NEVER = sql<string>`'infinity'`;

/**
 * `CacheProvider` (`@maroonedsoftware/cache`) against `runner.cache_entries` — this deployment's
 * Postgres-only stand-in for the package's only shipped backend, `IoRedisCacheProvider`, which this
 * card's Constraints rule out (no Redis service, no client dependency, and adding one for this alone
 * is out of proportion). Follows `SourceCursorRepository`'s own reasoning for writing a repository
 * against a table that was already there, one level over.
 *
 * `key` is `runner.cache_entries`'s primary key, so every write below is a plain `WHERE key = ?`
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
            .selectFrom('runner.cacheEntries')
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
            .insertInto('runner.cacheEntries')
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
            .insertInto('runner.cacheEntries')
            .values({ key, value, expiresAt })
            .onConflict(oc => oc.column('key').doUpdateSet({ value, expiresAt }).where('runner.cacheEntries.expiresAt', '<=', now()))
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
            .updateTable('runner.cacheEntries')
            .set(ttl ? { value, expiresAt: expiresAtFor(ttl) } : { value })
            .where('key', '=', key)
            .where('expiresAt', '>', now())
            .execute();
    }

    /** Removes `key` regardless of whether it has expired, returning the key that was deleted, or
     * `null` if it was already absent — `CacheProvider.delete`'s own contract. */
    async delete(key: string): Promise<string | null> {
        const row = await this.db.deleteFrom('runner.cacheEntries').where('key', '=', key).returning('key').executeTakeFirst();
        return row?.key ?? null;
    }
}
