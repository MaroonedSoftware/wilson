-- migrate:up

-- =========================================================================
-- runner.projects — a project's identity: its name, plus the four paths
-- `BoardConfig` exposes (board root, code root, worktree root, run root).
--
-- Card 0148: `BoardConfig` used to be assembled fresh from PROJECT_NAME,
-- PROJECT_CODE_ROOT, PROJECT_BOARD_ROOT and friends every time the daemon
-- booted, with no record of it an operator could read. This table is that
-- record. `BoardModule.setup` reads the row for the configured project on
-- boot; if none exists yet (a first boot), it creates one from the
-- environment exactly as configured today. From then on the row wins
-- outright — the environment seeds it once and is never consulted again
-- while a row exists, so an operator who edits the row and restarts with
-- stale environment variables gets the row's value, not whichever the
-- shell that happened to start the daemon carried.
--
-- `name` is the same value every other `runner` table's `project` column
-- already holds — not a new identifier. One project for now (PROJECT.md,
-- "not in step 0": multi-project): this table exists so the seam is there
-- before there is a second row to put in it, not to serve one yet. It
-- describes a project; it does not migrate, backfill or re-key any of the
-- eight existing `runner` tables that already carry `project`.
-- =========================================================================

CREATE TABLE runner.projects (
    name TEXT PRIMARY KEY,
    board_root TEXT NOT NULL,
    code_root TEXT NOT NULL,
    worktree_root TEXT NOT NULL,
    run_root TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- migrate:down

DROP TABLE runner.projects;
