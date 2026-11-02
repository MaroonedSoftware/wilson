-- migrate:up

-- =========================================================================
-- What each saved engine token signs in to, ahead of Wilson choosing between
-- them. Every token saved so far is a `claude setup-token` token, which is
-- what the defaults say, and `priority` 0 is where a pool will start: lower
-- comes first.
--
-- TEXT rather than enums, as on wilson.stage_routing: the contract validates
-- these, so a new provider is a code change and not a migration.
-- =========================================================================

ALTER TABLE wilson.engine_tokens
    ADD COLUMN provider TEXT NOT NULL DEFAULT 'anthropic',
    ADD COLUMN kind TEXT NOT NULL DEFAULT 'subscription',
    ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;

-- migrate:down

ALTER TABLE wilson.engine_tokens
    DROP COLUMN priority,
    DROP COLUMN kind,
    DROP COLUMN provider;
