-- migrate:up

-- =========================================================================
-- Whether an operator vouches that a host keeps a stage from everything but
-- its own work, such as a container worker with no other credentials or
-- projects inside. A stage marked `isolated` runs on nothing else. Nothing can
-- test this from outside, so it is off until someone says so.
-- =========================================================================

ALTER TABLE wilson.hosts
    ADD COLUMN isolated BOOLEAN NOT NULL DEFAULT false;

-- migrate:down

ALTER TABLE wilson.hosts
    DROP COLUMN isolated;
