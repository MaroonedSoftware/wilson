-- migrate:up

-- =========================================================================
-- runner.settings — operational settings that can change without a restart.
--
-- POLLER_ENABLED used to be read once, at boot, in JobsModule.setup — the
-- only way to change it was to restart the API, and a restart abandons
-- whatever stage is running. This table is where the same decision lives
-- instead: a row here overrides the environment variable, and
-- SettingsStore (apps/api/src/modules/settings) is asked again on every
-- read, so a write takes effect immediately, no restart involved.
--
-- One row per (project, key), keyed the same way every other operational
-- table in this schema is (runner.card_jobs among them). `value` is JSONB
-- so a new setting is a new row, never a schema change — adding
-- POLLER_INTERVAL_MS or CARD_STAGE_CONCURRENCY later does not touch this
-- table.
--
-- Not everything the process reads from the environment belongs here.
-- Secrets and deployment topology (DATABASE_URL, provider keys, PROJECT_*
-- roots) stay in the environment, where they are already managed; what
-- moves here is operational policy an operator changes while the system
-- runs.
-- =========================================================================

CREATE TABLE runner.settings (
    project TEXT NOT NULL,
    key TEXT NOT NULL,
    value JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (project, key)
);

-- migrate:down

DROP TABLE runner.settings;
