-- migrate:up

-- =========================================================================
-- The board repo is gone.
--
-- `board_root` named the sibling `*.board` git repo: markdown cards under
-- `cards/` until 20260824120000_board_tables.sql moved them here, and
-- `config/stages.yaml` until 20260901120000_stage_configs.sql moved that
-- here too. Nothing reads the directory any more, so the column that
-- located it goes with it. The three remaining paths are the code repo and
-- the two scratch roots (worktrees, run state) — machine layout the daemon
-- still needs.
--
-- Apply this only after the daemon is running code that no longer selects
-- the column: an older process reads `board_root` on every poller tick and
-- every boot, and would fail on each until restarted.
-- =========================================================================

ALTER TABLE runner.projects DROP COLUMN board_root;

-- migrate:down

-- Re-added with a default rather than restored: the values are not
-- recoverable, and nothing on the way back down reads them either.
ALTER TABLE runner.projects ADD COLUMN board_root TEXT NOT NULL DEFAULT '';
