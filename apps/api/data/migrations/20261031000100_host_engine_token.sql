-- migrate:up

-- =========================================================================
-- Which saved engine token a worker host's engines sign in with. Null leaves
-- the worker's own sign-in. Removing a token clears it from its hosts rather
-- than being refused, since revoking must never wait on a reassignment.
-- =========================================================================

ALTER TABLE wilson.hosts
    ADD COLUMN engine_token TEXT REFERENCES wilson.engine_tokens (name) ON DELETE SET NULL,
    ADD CONSTRAINT hosts_engine_token_only_for_workers CHECK (engine_token IS NULL OR kind = 'worker');

-- migrate:down

ALTER TABLE wilson.hosts DROP COLUMN engine_token;
