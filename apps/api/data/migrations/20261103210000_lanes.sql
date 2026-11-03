-- migrate:up

-- =========================================================================
-- wilson.lanes — one row per lane, per project, replacing the YAML document
-- in wilson.stage_configs and the routing in wilson.stage_routing.
--
-- Lanes rarely change, and an operator changes one field of one lane at a
-- time, so a whole document is more machinery than the job needs. The columns
-- are what something reads or edits on its own. `settings` holds the rest of a
-- lane (budgets, commands, placement), validated by `StageConfigSchema` on every
-- load, so a new setting is a code change and not a migration.
--
-- adapter, provider and model are NULL on a lane that runs no model.
-- =========================================================================

CREATE TABLE wilson.lanes (
    project TEXT NOT NULL,
    name TEXT NOT NULL,
    position INTEGER NOT NULL,
    mode TEXT NOT NULL,
    worktree TEXT NOT NULL,
    on_pass TEXT NOT NULL,
    on_fail TEXT NOT NULL,
    adapter TEXT,
    provider TEXT,
    model TEXT,
    instructions TEXT NOT NULL,
    settings JSONB NOT NULL DEFAULT '{}',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (project, name)
);

-- =========================================================================
-- wilson.project_lane_settings — what a project's lanes share.
--
-- imported_config_id is the newest wilson.stage_configs row these tables
-- reflect. A newer document means they are stale, and config is read from the
-- document until the next import, so nothing written there is silently ignored.
-- =========================================================================

CREATE TABLE wilson.project_lane_settings (
    project TEXT PRIMARY KEY,
    scope_violation TEXT NOT NULL,
    always_allowed TEXT[] NOT NULL DEFAULT '{}',
    deny TEXT[] NOT NULL DEFAULT '{}',
    sandbox JSONB NOT NULL,
    imported_config_id BIGINT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =========================================================================
-- wilson.lane_revisions — every change to the two tables above, append-only.
--
-- `lane` is NULL for a project-wide change, and `snapshot` is NULL when a lane
-- was removed. The newest id is also what a cached parse of the config is keyed
-- on, since every change adds a row here.
-- =========================================================================

CREATE TABLE wilson.lane_revisions (
    id BIGSERIAL PRIMARY KEY,
    project TEXT NOT NULL,
    lane TEXT,
    snapshot JSONB,
    message TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX lane_revisions_project_id_idx ON wilson.lane_revisions (project, id DESC);

-- migrate:down

DROP TABLE wilson.lane_revisions;
DROP TABLE wilson.project_lane_settings;
DROP TABLE wilson.lanes;
