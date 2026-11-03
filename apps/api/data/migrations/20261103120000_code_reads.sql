-- migrate:up

-- =========================================================================
-- Every read of a project's code through the chat or the HTTP surface, and
-- every refusal of one. Not `wilson.card_events`: its `card_id` is NOT NULL
-- and these reads have no card. Append-only, so nothing here is ever updated.
--
-- `commit_sha` is null for a read refused before its ref resolved, and `reason`
-- for one that succeeded. `subject` is the account of the session that asked.
-- =========================================================================

CREATE TABLE wilson.code_reads (
    id BIGSERIAL PRIMARY KEY,
    project TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('list', 'read', 'search')),
    path TEXT,
    ref TEXT,
    commit_sha TEXT,
    pattern TEXT,
    subject TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('read', 'refused', 'failed')),
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX code_reads_project_created_at ON wilson.code_reads (project, created_at DESC);

-- migrate:down

DROP TABLE wilson.code_reads;
