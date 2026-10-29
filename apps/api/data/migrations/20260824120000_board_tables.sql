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
-- `runner.cards` is current state — what `card list` and dispatch read.
-- `runner.card_versions` is append-only history — the replacement for `git
-- log` on the board repo, and the thing `planSha` used to point at.
-- =========================================================================

CREATE TABLE runner.cards (
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

CREATE TABLE runner.card_versions (
    id BIGSERIAL PRIMARY KEY,
    project TEXT NOT NULL,
    card_id TEXT NOT NULL,
    frontmatter JSONB NOT NULL,
    body TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (project, card_id) REFERENCES runner.cards (project, id) ON DELETE CASCADE
);

CREATE INDEX card_versions_project_card_id_idx ON runner.card_versions (project, card_id, id);

-- The one ALTER in the schema, and a necessary one: cards and card_versions
-- reference each other, so whichever is created first cannot name the other.
ALTER TABLE runner.cards
    ADD CONSTRAINT cards_pinned_version_id_fkey
    FOREIGN KEY (pinned_version_id) REFERENCES runner.card_versions (id);

-- =========================================================================
-- Dependencies as rows, so a dependency on a card that does not exist is
-- rejected by the database rather than absorbed in code. `nextCard` treated a
-- missing dependency as unfinished — a good defensive choice made necessary by
-- having no referential integrity, and no longer necessary.
--
-- No foreign key from runner.card_events: its rows predate this table and
-- carry board coordinates as text on purpose, so history survives a card
-- format change. Adding one would require validating existing rows against a
-- table that is empty until the importer runs.
-- =========================================================================

CREATE TABLE runner.card_deps (
    project TEXT NOT NULL,
    card_id TEXT NOT NULL,
    depends_on_id TEXT NOT NULL,
    PRIMARY KEY (project, card_id, depends_on_id),
    FOREIGN KEY (project, card_id) REFERENCES runner.cards (project, id) ON DELETE CASCADE,
    FOREIGN KEY (project, depends_on_id) REFERENCES runner.cards (project, id) ON DELETE RESTRICT,
    CHECK (card_id <> depends_on_id)
);

-- migrate:down

DROP TABLE runner.card_deps;
ALTER TABLE runner.cards DROP CONSTRAINT cards_pinned_version_id_fkey;
DROP TABLE runner.card_versions;
DROP TABLE runner.cards;
