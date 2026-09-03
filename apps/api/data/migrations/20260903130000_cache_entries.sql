-- migrate:up

-- =========================================================================
-- runner.cache_entries — a generic key/value store with expiry, backing
-- @maroonedsoftware/cache's CacheProvider for this deployment.
--
-- Card 0197's own note flags the cost up front: that package's only shipped
-- CacheProvider is IoRedisCacheProvider, and this deployment has run
-- entirely on Postgres so far — no Redis service, no client dependency.
-- This table is what lets card 0197 use IdempotencyStore (the actual thing
-- PROJECT.md's "Card sources" asks for — claim, TTL, dead-letter after
-- repeated failures) without standing up a second stateful service for it,
-- the same reasoning card 0198 gave for writing runner.source_cursors
-- rather than reaching for infrastructure that was not already there.
--
-- Deliberately generic — key/value/expiry, nothing about cards or sources —
-- because CacheProvider itself is generic; a PostgresCacheProvider over
-- this table is a drop-in for IoRedisCacheProvider, and any future caller
-- of that interface reuses this table rather than inventing another.
--
-- `expires_at` rather than a TTL column: every CacheProvider method already
-- takes or computes an absolute point, and storing the deadline directly is
-- what makes both `get` (WHERE expires_at > now()) and the atomic
-- claim `add` needs (an expired row must be treated as absent) a plain
-- comparison, not a computed one on every read.
--
-- No background sweep of expired rows. A cheap thing to add later if
-- dead rows ever matter; today's only writer is card 0197's idempotency
-- keys, evicted correctly (as absent) by every read regardless of whether
-- anyone ever deletes the row.
-- =========================================================================

CREATE TABLE runner.cache_entries (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL
);

-- migrate:down

DROP TABLE runner.cache_entries;
