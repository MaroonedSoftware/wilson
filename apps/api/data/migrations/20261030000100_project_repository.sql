-- migrate:up

-- =========================================================================
-- wilson.projects.repository: the GitHub repository a project's code comes
-- from, as `owner/name`. Absent for a project registered by path alone.
-- =========================================================================

ALTER TABLE wilson.projects ADD COLUMN repository TEXT;

-- migrate:down

ALTER TABLE wilson.projects DROP COLUMN repository;
