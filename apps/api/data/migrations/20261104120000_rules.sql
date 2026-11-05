-- migrate:up

-- =========================================================================
-- wilson.rules — one row per checked rule, per project.
--
-- A rule is something a person decided must hold in a project's code. Each one
-- that matches a card's diff gets its own model call at review. `paths` are
-- picomatch globs, matched with `dot: true`, against changed paths. `severity`
-- says how far a failure can go: 'blocker' sends the card back when the judge
-- cites a real line, and 'concern' only ever reports.
--
-- revision_id is the row's newest wilson.rule_revisions id, which is what a
-- verdict is keyed on: changing a rule's words makes every earlier verdict about
-- it not count.
-- =========================================================================

CREATE TABLE wilson.rules (
    project TEXT NOT NULL,
    id TEXT NOT NULL,
    statement TEXT NOT NULL,
    paths TEXT[] NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('blocker', 'concern')),
    revision_id BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (project, id)
);

-- =========================================================================
-- wilson.rule_revisions — every change to the table above, append-only.
--
-- `snapshot` is NULL when the rule was removed.
-- =========================================================================

CREATE TABLE wilson.rule_revisions (
    id BIGSERIAL PRIMARY KEY,
    project TEXT NOT NULL,
    rule TEXT NOT NULL,
    snapshot JSONB,
    message TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX rule_revisions_project_id_idx ON wilson.rule_revisions (project, id DESC);

-- migrate:down

DROP TABLE wilson.rule_revisions;
DROP TABLE wilson.rules;
