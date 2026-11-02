-- migrate:up

-- =========================================================================
-- wilson.stage_routing — which engine, provider and model each stage runs on.
--
-- Everything else about a stage is long text edited as a whole, which is why
-- wilson.stage_configs is one document. These three fields are the part an
-- operator wants to change one at a time, from a control rather than an
-- editor, without rewriting the document and revalidating every route.
--
-- The same shape as wilson.stage_configs, deliberately: one row per write,
-- append-only, and the newest row for a (project, stage) is its current
-- routing. So a change has a reason beside it and undoing one is saving the
-- earlier values again, never deleting anything.
--
-- TEXT rather than enums, as on wilson.settings: `StageConfigSchema` validates
-- these on every load, so a new provider is a code change and not a migration.
-- =========================================================================

CREATE TABLE wilson.stage_routing (
    id BIGSERIAL PRIMARY KEY,
    project TEXT NOT NULL,
    stage TEXT NOT NULL,
    adapter TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX stage_routing_project_stage_id_idx ON wilson.stage_routing (project, stage, id DESC);

-- migrate:down

DROP TABLE wilson.stage_routing;
