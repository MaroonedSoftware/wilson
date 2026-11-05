-- migrate:up

-- =========================================================================
-- wilson.eval_batches, wilson.eval_runs — fixtures run again under a config.
--
-- A batch freezes what it compares when it is created: each arm's whole lane
-- document and the project's learnings, so a lane edit made while it runs
-- cannot change half of its results. `candidate` is empty for a batch that
-- only measures the lanes as they stand.
--
-- What a run spent is here and not on wilson.card_events. A card's input
-- budget and the daily ceiling both read stage events, and an eval is held to
-- neither: `max_output_tokens` is its own limit.
--
-- A fixture a run used cannot be removed while the run is kept, since the
-- run means nothing without knowing what it replayed.
-- =========================================================================

CREATE TABLE wilson.eval_batches (
    id BIGSERIAL PRIMARY KEY,
    project TEXT NOT NULL,
    host TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    stop_reason TEXT,
    waiting_reason TEXT,
    runs_per_fixture INTEGER NOT NULL,
    max_output_tokens INTEGER NOT NULL,
    current_lanes JSONB NOT NULL,
    candidate_lanes JSONB,
    candidate JSONB,
    learnings TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ,
    CONSTRAINT eval_batches_status_check CHECK (status IN ('running', 'finished', 'stopped'))
);

CREATE INDEX eval_batches_project_id_idx ON wilson.eval_batches (project, id);

CREATE TABLE wilson.eval_runs (
    id BIGSERIAL PRIMARY KEY,
    project TEXT NOT NULL,
    batch_id BIGINT NOT NULL REFERENCES wilson.eval_batches (id) ON DELETE CASCADE,
    fixture_id BIGINT NOT NULL REFERENCES wilson.eval_fixtures (id) ON DELETE RESTRICT,
    arm TEXT NOT NULL,
    position INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    failures JSONB NOT NULL DEFAULT '[]'::JSONB,
    unjudged BOOLEAN NOT NULL DEFAULT FALSE,
    report_rejected BOOLEAN NOT NULL DEFAULT FALSE,
    truncated BOOLEAN NOT NULL DEFAULT FALSE,
    error TEXT,
    result JSONB,
    patch TEXT,
    patch_truncated BOOLEAN NOT NULL DEFAULT FALSE,
    wall_clock_ms INTEGER,
    input_tokens INTEGER,
    cached_input_tokens INTEGER,
    output_tokens INTEGER,
    tool_calls INTEGER,
    scope_denials INTEGER,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    CONSTRAINT eval_runs_arm_check CHECK (arm IN ('current', 'candidate')),
    CONSTRAINT eval_runs_status_check CHECK (status IN ('queued', 'running', 'passed', 'failed', 'errored', 'interrupted', 'abandoned', 'skipped')),
    UNIQUE (batch_id, position)
);

CREATE INDEX eval_runs_status_idx ON wilson.eval_runs (status) WHERE status = 'running';

-- migrate:down

DROP TABLE wilson.eval_runs;
DROP TABLE wilson.eval_batches;
