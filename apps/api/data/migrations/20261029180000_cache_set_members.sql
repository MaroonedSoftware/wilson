-- migrate:up

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
