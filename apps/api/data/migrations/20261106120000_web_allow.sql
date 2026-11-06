-- migrate:up

-- A project's webAllow list (card 0019): the hosts a stage may fetch pages from, carried exactly as
-- always_allowed is. Empty, the default, means no web access, as before this column existed.
ALTER TABLE wilson.project_lane_settings
    ADD COLUMN web_allow TEXT[] NOT NULL DEFAULT '{}';

-- migrate:down

ALTER TABLE wilson.project_lane_settings
    DROP COLUMN web_allow;
