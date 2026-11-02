-- migrate:up

-- =========================================================================
-- Which accounts have hit a usage limit, and until when. One row per account
-- and kind of limit, since a five-hour limit and a seven-day one end apart.
--
-- `account` is not a reference to wilson.engine_tokens: a worker's own sign-in
-- and this machine's have limits too, and neither has a row there. A saved
-- token clears its own rows when it is replaced or removed.
-- =========================================================================

CREATE TABLE wilson.engine_limits (
    account TEXT NOT NULL,
    limit_type TEXT NOT NULL,
    resets_at TIMESTAMPTZ NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (account, limit_type)
);

-- migrate:down

DROP TABLE wilson.engine_limits;
