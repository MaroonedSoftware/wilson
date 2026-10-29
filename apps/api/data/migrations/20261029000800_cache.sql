-- migrate:up

-- =========================================================================
-- wilson.cache_entries — a generic key/value store with expiry, backing
-- @maroonedsoftware/cache's CacheProvider for this deployment.
--
-- Card 0197's own note flags the cost up front: that package's only shipped
-- CacheProvider is IoRedisCacheProvider, and this deployment has run
-- entirely on Postgres so far — no Redis service, no client dependency.
-- This table is what lets card 0197 use IdempotencyStore (the actual thing
-- PROJECT.md's "Card sources" asks for — claim, TTL, dead-letter after
-- repeated failures) without standing up a second stateful service for it,
-- the same reasoning card 0198 gave for writing wilson.source_cursors
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

CREATE TABLE wilson.cache_entries (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL
);

-- =========================================================================
-- wilson.cache_set_members: the set half of CacheProvider, which
-- @maroonedsoftware/cache 0.6 added (setAdd / setRemove / setMembers).
--
-- @maroonedsoftware/authentication 6 keeps one set per signed-in subject,
-- naming every live session token it holds, so "sign out everywhere" and
-- the session list can find them. Two sign-ins at once each add a member to
-- the same set, which is why a set is rows rather than a serialised list in
-- wilson.cache_entries.value: a read-modify-write of one value loses one of
-- the two, and an insert of one row per member cannot.
--
-- `expires_at` is per row but is the set's expiry, not the member's: every
-- write moves every live member of the key to the same deadline, the way
-- Redis gives one TTL to the whole key. Expired rows are absent to every
-- read, and nothing sweeps them, as with wilson.cache_entries.
-- =========================================================================

CREATE TABLE wilson.cache_set_members (
    key TEXT NOT NULL,
    member TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (key, member)
);

-- migrate:down

DROP TABLE wilson.cache_set_members;

DROP TABLE wilson.cache_entries;
