-- migrate:up

-- =========================================================================
-- A worker host follows its engine token's name, so renaming a token is one
-- UPDATE of wilson.engine_tokens and not an unassign-and-reassign of every
-- host that holds it. The inline REFERENCES from host_engine_token had no
-- ON UPDATE action, so that UPDATE was refused outright.
--
-- ON DELETE SET NULL stays: removing a token clears it from its hosts rather
-- than being refused, since revoking must never wait on a reassignment. Not
-- DEFERRABLE: the cascade is what moves the hosts, inside the same statement.
-- =========================================================================

ALTER TABLE wilson.hosts DROP CONSTRAINT hosts_engine_token_fkey;

ALTER TABLE wilson.hosts
    ADD CONSTRAINT hosts_engine_token_fkey
    FOREIGN KEY (engine_token) REFERENCES wilson.engine_tokens (name) ON UPDATE CASCADE ON DELETE SET NULL;

-- migrate:down

ALTER TABLE wilson.hosts DROP CONSTRAINT hosts_engine_token_fkey;

ALTER TABLE wilson.hosts
    ADD CONSTRAINT hosts_engine_token_fkey
    FOREIGN KEY (engine_token) REFERENCES wilson.engine_tokens (name) ON DELETE SET NULL;
