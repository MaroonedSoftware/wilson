-- migrate:up

-- =========================================================================
-- wilson.apps: the operator apps installed on this server. An app is one HTML
-- file, which the web app runs in a sandboxed iframe with web requests blocked and
-- no credentials, plus the grants it was installed with: what the web app may
-- fetch on its behalf.
--
-- Deployment-scoped like wilson.hosts, not per project: the route an app is
-- opened at names the project, and the app cannot ask for another.
--
-- `grants` has no CHECK: the contract's AppGrant enum refuses an unknown grant,
-- and adding one should not take a migration.
-- =========================================================================

CREATE TABLE wilson.apps (
    slug TEXT PRIMARY KEY CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    html TEXT NOT NULL,
    grants TEXT[] NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- migrate:down

DROP TABLE wilson.apps;
