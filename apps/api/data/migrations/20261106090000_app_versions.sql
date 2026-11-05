-- migrate:up

-- Which version of an operator app is installed, and which version of the app API (`app.api.ck`) it was
-- written for. A host refuses to open an app whose API version it does not offer, rather than running it
-- against answers it was not written for.
--
-- `version` is the app's own label, shown to the operator and compared on a replace. Null for an app
-- installed before apps said. Every app installed before this was written for version 1.
ALTER TABLE wilson.apps
    ADD COLUMN version TEXT,
    ADD COLUMN api_version INTEGER NOT NULL DEFAULT 1 CHECK (api_version >= 1);

-- migrate:down

ALTER TABLE wilson.apps
    DROP COLUMN version,
    DROP COLUMN api_version;
