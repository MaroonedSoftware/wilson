-- migrate:up

-- =========================================================================
-- The board moves into Postgres.
--
-- Until now the board was markdown in a sibling git repo and this database
-- held only operational state (PROJECT.md decision 1, as it stood). That split
-- made every transition a two-phase write: commit the card file to git, then
-- append the event here, with no way to reconcile a partial failure. These
-- tables exist so a transition and the event describing it land in one
-- transaction.
--
-- `wilson.cards` is current state — what `card list` and dispatch read.
-- `wilson.card_versions` is append-only history — the replacement for `git
-- log` on the board repo, and the thing `planSha` used to point at.
-- =========================================================================

CREATE TABLE wilson.cards (
    project TEXT NOT NULL,
    id TEXT NOT NULL,
    title TEXT NOT NULL,
    stage TEXT NOT NULL,
    branch TEXT,
    -- The current plan text. `card_versions.body` holds the historical snapshots;
    -- this is what `read` returns and what the next version is cut from.
    body TEXT NOT NULL,
    -- Kickback counters keyed by the stage that kicked back, e.g. {"review": 1}.
    retries JSONB NOT NULL DEFAULT '{}'::JSONB,
    -- External source refs, e.g. {"linear": "ENG-123"}.
    external JSONB,
    source_closed BOOLEAN,
    -- Orders the parking lot. Null everywhere else; ordering is not runner state.
    position INTEGER,
    -- The version downstream stages read. Null means "not approved yet", and a
    -- stage then runs against current state, which is what an absent planSha did.
    pinned_version_id BIGINT,
    -- A person has to look at this card before it runs again. A property the
    -- card carries wherever it sits, so it can stay in its stage and keep its
    -- worktree rather than moving to a lane that loses both.
    needs_human BOOLEAN NOT NULL DEFAULT FALSE,
    -- What the runner or the operator said when they set the flag.
    needs_human_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (project, id)
);

SELECT wilson.add_updated_at_trigger('wilson.cards');

-- =========================================================================
-- Every write snapshots the whole card, not just the plan body.
--
-- `readAt` used to be `git show <sha>:<path>`, which returned frontmatter and
-- body together, and the dispatcher reads both from the pinned card —
-- `assertDispatchable` checks the pinned `stage` and `dependsOn`, and the
-- branch name comes from the pinned `title`. Storing only the body would
-- silently change dispatch semantics, so a version is a full snapshot.
--
-- `message` is what the git commit message used to be. It is the audit
-- narrative, kept deliberately: "0018: implementing -> testing".
-- =========================================================================

CREATE TABLE wilson.card_versions (
    id BIGSERIAL PRIMARY KEY,
    project TEXT NOT NULL,
    card_id TEXT NOT NULL,
    frontmatter JSONB NOT NULL,
    body TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (project, card_id) REFERENCES wilson.cards (project, id) ON DELETE CASCADE
);

CREATE INDEX card_versions_project_card_id_idx ON wilson.card_versions (project, card_id, id);

-- The one ALTER in the schema, and a necessary one: cards and card_versions
-- reference each other, so whichever is created first cannot name the other.
ALTER TABLE wilson.cards
    ADD CONSTRAINT cards_pinned_version_id_fkey
    FOREIGN KEY (pinned_version_id) REFERENCES wilson.card_versions (id);

-- =========================================================================
-- Dependencies as rows, so a dependency on a card that does not exist is
-- rejected by the database rather than absorbed in code. `nextCard` treated a
-- missing dependency as unfinished — a good defensive choice made necessary by
-- having no referential integrity, and no longer necessary.
--
-- No foreign key from wilson.card_events: its rows predate this table and
-- carry board coordinates as text on purpose, so history survives a card
-- format change. Adding one would require validating existing rows against a
-- table that is empty until the importer runs.
-- =========================================================================

CREATE TABLE wilson.card_deps (
    project TEXT NOT NULL,
    card_id TEXT NOT NULL,
    depends_on_id TEXT NOT NULL,
    PRIMARY KEY (project, card_id, depends_on_id),
    FOREIGN KEY (project, card_id) REFERENCES wilson.cards (project, id) ON DELETE CASCADE,
    FOREIGN KEY (project, depends_on_id) REFERENCES wilson.cards (project, id) ON DELETE RESTRICT,
    CHECK (card_id <> depends_on_id)
);

-- =========================================================================
-- wilson.card_events — the operational record.
--
-- Append-only: every claim, tool denial, scope grant, verification result and
-- transition lands here and nothing ever updates or deletes a row. The card
-- file in the board repo is the durable record; this table is what the runner
-- reads to answer "what happened", and (from step 3) to recover after a crash.
--
-- No foreign key to a cards table because there isn't one: cards live in the
-- board repo as markdown, and Postgres holds no copy of them. `project` and
-- `card_id` are the board coordinates, carried as text on purpose so a board
-- format change cannot orphan history.
-- =========================================================================

CREATE TABLE wilson.card_events (
    id BIGSERIAL PRIMARY KEY,
    project TEXT NOT NULL,
    card_id TEXT NOT NULL,
    stage TEXT,
    type TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The read pattern is always "the tail of one card's log, in order".
CREATE INDEX card_events_project_card_id_idx ON wilson.card_events (project, card_id, id);

-- =========================================================================
-- wilson.card_jobs — which job, if any, is currently carrying a card.
--
-- The runner had no way to answer "is this card in flight right now?". Three
-- problems came out of that one gap: a job could be redelivered while its stage
-- was still running, `card start` could enqueue a card that was already
-- running, and a stage left behind by a dead worker was indistinguishable from
-- one still working.
--
-- Operational state, not board state, so it is a table of its own rather than a
-- column on wilson.cards. `Card` and its frontmatter say nothing about jobs.
--
-- One row per card at most: a card has one job carrying it or none. The row is
-- a claim, never the answer — the broker's view of that job id decides, and a
-- row whose job has finished is deleted on read. See CardJobs.inFlight.
-- =========================================================================

CREATE TABLE wilson.card_jobs (
    project TEXT NOT NULL,
    card_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    enqueued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (project, card_id),
    FOREIGN KEY (project, card_id) REFERENCES wilson.cards (project, id) ON DELETE CASCADE
);

-- =========================================================================
-- wilson.leases — an exclusive claim on a resource, held for as long as the
-- card that took it holds its worktree.
--
-- Card 0165, the split card 0027's review asked for: 0027 wants a port per
-- worktree so parallel dev servers do not collide, and its review found that
-- nothing allocates ports today — this is "build leasing, of which ports are
-- the first type", not "generalise port allocation". This table is the
-- mechanism alone; nothing in the repo takes a lease yet.
--
-- `resource_key` is the primary key, and it is deliberately NOT scoped by
-- project — the one exception to how every other `wilson` table in this
-- schema is keyed (`wilson.card_jobs`, `wilson.settings`, both
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

CREATE TABLE wilson.leases (
    resource_key TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    card_id TEXT NOT NULL,
    acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (project, card_id) REFERENCES wilson.cards (project, id) ON DELETE CASCADE
);

-- =========================================================================
-- wilson.card_context — a snapshot of external context attached to a card.
--
-- First of six in the context-provider slice (PROJECT.md, "Context
-- providers"). Rows, not files: the database is operator-private by
-- construction and the code repo is the one that gets shared, so a
-- snapshot never touches the worktree. This card only gives the snapshot
-- somewhere to live; nothing writes to it yet. The `ContextProvider`
-- interface and the URL provider are the provider-seam card; the HTTP
-- surface is the contract card; reading these rows back is three later
-- cards again.
--
-- The manifest (`source_url`, `fetched_at`, `fetched_by`) is what a
-- provider reported about the fetch; the content (`title`, `content`,
-- `content_hash`) is what it fetched. The schema cannot enforce the
-- trimming rule that content must be message text, author display name
-- and timestamp only, never emails, account ids or attachments — that is
-- a constraint on what a provider produces, enforced by the provider-seam
-- card, not by a column here.
--
-- `fetched_at` and `created_at` are both present and are not redundant:
-- `fetched_at` is manifest data the provider reports — when the source
-- said the content was current — and `created_at` is when this row was
-- written. They will be milliseconds apart today, when every provider
-- fetches live, and would not be if a provider ever served a cached
-- fetch. Do not delete one for looking duplicate.
--
-- `content_hash` is declared now and read by nobody yet. The retention
-- card keeps it after expiring `content`, so a later reader can still
-- tell whether two now-expired snapshots held the same document. Adding
-- a column to a populated table is strictly more work than declaring it
-- here before this table holds any rows.
--
-- `remove` (`CardContextRepository`) is a real delete, not a `resolved`-
-- style state: unlike `wilson.plan_comments`, a snapshot has no history
-- worth keeping once a person says it was the wrong document. That is a
-- different operation from retention's expiry, which keeps the manifest
-- and clears only the content.
-- =========================================================================

CREATE TABLE wilson.card_context (
    id BIGSERIAL PRIMARY KEY,
    project TEXT NOT NULL,
    card_id TEXT NOT NULL,
    -- The manifest: what the provider reported about the fetch.
    source_url TEXT NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL,
    fetched_by TEXT NOT NULL,
    -- The content: what it fetched.
    title TEXT,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (project, card_id) REFERENCES wilson.cards (project, id) ON DELETE CASCADE
);

CREATE INDEX card_context_project_card_id_idx ON wilson.card_context (project, card_id, id);

-- migrate:down

DROP TABLE wilson.card_context;

DROP TABLE wilson.leases;

DROP TABLE wilson.card_jobs;

DROP TABLE wilson.card_events;

DROP TABLE wilson.card_deps;
ALTER TABLE wilson.cards DROP CONSTRAINT cards_pinned_version_id_fkey;
DROP TABLE wilson.card_versions;
DROP TABLE wilson.cards;
