-- migrate:up

-- =========================================================================
-- runner.leases — an exclusive claim on a resource, held for as long as the
-- card that took it holds its worktree.
--
-- Card 0165, the split card 0027's review asked for: 0027 wants a port per
-- worktree so parallel dev servers do not collide, and its review found that
-- nothing allocates ports today — this is "build leasing, of which ports are
-- the first type", not "generalise port allocation". This table is the
-- mechanism alone; nothing in the repo takes a lease yet.
--
-- `resource_key` is the primary key, and it is deliberately NOT scoped by
-- project — the one exception to how every other `runner` table in this
-- schema is keyed (`runner.card_jobs`, `runner.settings`, both
-- `(project, ...)`, per cards 0149/0150). Those tables are project-scoped
-- because two projects' *board* state never collides. A lease is different:
-- a TCP port or a database name is a property of the *machine*, not the
-- project, so two registered projects on one host really do contend for the
-- same port 3000. `project` is still recorded on the row, but only as part
-- of who holds the resource, never as part of what makes it unique — do not
-- "fix" this to a composite `(project, resource_key)` primary key. That
-- would let two projects hold the same machine resource at once, which is
-- exactly the bug this table exists to prevent.
--
-- `card_id` is who holds it, with the same foreign key `card_jobs` carries
-- so a lease row cannot reference a card that does not exist. The ordinary
-- way a lease goes away is explicit, not the cascade: `WorktreeManager`
-- releases a card's leases when its worktree is reclaimed
-- (worktree.manager.ts). A lease left behind by a card that is no longer
-- running — a daemon killed mid-stage — is swept by reconciling against
-- card state at the next acquire attempt, the same idea `reclaimIfTerminal`
-- already uses for a stuck worktree, rather than a heartbeat; see
-- `LeaseService` (apps/api/src/modules/lease/lease.service.ts) for exactly
-- what "no longer running" checks.
-- =========================================================================

CREATE TABLE runner.leases (
    resource_key TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    card_id TEXT NOT NULL,
    acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (project, card_id) REFERENCES runner.cards (project, id) ON DELETE CASCADE
);

-- migrate:down

DROP TABLE runner.leases;
