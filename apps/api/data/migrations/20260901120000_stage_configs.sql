-- migrate:up

-- =========================================================================
-- runner.stage_configs — the stage configuration, in Postgres.
--
-- Until now the stage config was `config/stages.yaml` in the sibling board
-- repo: the last piece of board state still on disk after the cards moved
-- (20260824120000_board_tables.sql), and the only reason `board_root` still
-- existed on `runner.projects`. This table replaces the file, and the board
-- repo's `git log` on it.
--
-- One row per write, append-only; the newest row for a project is its
-- current config. There is no separate "current" table the way cards have
-- `runner.cards` beside `runner.card_versions`, because a stage config has
-- no other mutable state to keep beside the document — the newest row *is*
-- the current state, and an `ORDER BY id DESC LIMIT 1` says so without an
-- upsert that could disagree with its own history.
--
-- `yaml` is the document verbatim, comments included, not columns per field.
-- The live file is some four hundred lines and most of it is commentary
-- explaining why each budget and route is what it is; that is the value of
-- the document, and a normalised schema would either drop it or need a
-- comment column per field. Validation is the same zod schema and route
-- check the file went through (`parseStages`, stage.config.ts), run on every
-- write and every read.
--
-- `message` is what the commit message on `stages.yaml` used to be — the
-- audit narrative, kept for the same reason `runner.card_versions.message`
-- is: "Raise the review step budget to 150".
-- =========================================================================

CREATE TABLE runner.stage_configs (
    id BIGSERIAL PRIMARY KEY,
    project TEXT NOT NULL,
    yaml TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX stage_configs_project_id_idx ON runner.stage_configs (project, id DESC);

-- migrate:down

DROP TABLE runner.stage_configs;
