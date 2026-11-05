-- migrate:up

-- =========================================================================
-- wilson.mcp_connections: outside MCP servers Wilson connects to. Wilson is the
-- only client, so a server's credential stays here and never reaches whatever
-- calls its tools. `secret` names a row in wilson.secrets, and a secret in use
-- cannot be removed. `project`, when set, is the one project it may be used in.
--
-- wilson.mcp_connection_tools: what each server last listed, and what the operator
-- decided about it. `fingerprint` hashes what the server says now and
-- `approved_fingerprint` what the operator last reviewed, so a tool is usable only
-- while the two match. `read_only_hint` is the server's own claim, kept to show the
-- operator and never used to decide anything.
-- =========================================================================

CREATE TABLE wilson.mcp_connections (
    name TEXT PRIMARY KEY CHECK (name ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
    url TEXT NOT NULL,
    secret TEXT REFERENCES wilson.secrets (name) ON DELETE RESTRICT,
    project TEXT REFERENCES wilson.projects (name) ON DELETE CASCADE,
    refreshed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE wilson.mcp_connection_tools (
    connection TEXT NOT NULL REFERENCES wilson.mcp_connections (name) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    input_schema JSONB NOT NULL,
    read_only_hint BOOLEAN NOT NULL DEFAULT false,
    access TEXT NOT NULL DEFAULT 'change' CHECK (access IN ('read', 'change', 'disabled')),
    fingerprint TEXT NOT NULL,
    approved_fingerprint TEXT,
    PRIMARY KEY (connection, name)
);

-- migrate:down

DROP TABLE wilson.mcp_connection_tools;
DROP TABLE wilson.mcp_connections;
