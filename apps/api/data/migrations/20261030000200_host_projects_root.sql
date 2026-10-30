-- migrate:up

-- =========================================================================
-- A folder on a host that any project with a GitHub repository can live
-- under. A stage for a project the host has no `wilson.host_projects` row for
-- gets one there, at `<projects_root>/<project>/{code,worktrees,run}`, which
-- is how one VM image serves every project. Null keeps the older rule: no
-- row, no work.
-- =========================================================================

ALTER TABLE wilson.hosts ADD COLUMN projects_root TEXT;

-- migrate:down

ALTER TABLE wilson.hosts DROP COLUMN projects_root;
