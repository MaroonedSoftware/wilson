-- migrate:up

-- =========================================================================
-- Which saved tokens Wilson may choose between. Off by default, so a token
-- saved for one host goes on being that host's alone until someone says
-- otherwise.
-- =========================================================================

ALTER TABLE wilson.engine_tokens
    ADD COLUMN pooled BOOLEAN NOT NULL DEFAULT false;

-- migrate:down

ALTER TABLE wilson.engine_tokens
    DROP COLUMN pooled;
