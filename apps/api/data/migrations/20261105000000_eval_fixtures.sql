-- migrate:up

-- =========================================================================
-- wilson.eval_fixtures — one past stage attempt, kept to be run again.
--
-- `plan` is a copy of the card as that attempt read it, not a reference to a
-- card version, for the reason a context snapshot is a copy: the input is
-- pinned, whatever later happens to the card. `base_sha` and `head_sha` are
-- kept alive by refs/wilson/eval/<id>/{base,head} in the project's clone,
-- since an attempt that was kicked back may be on no branch at all.
--
-- `source_event_id` is that attempt's `stage.dispatched` row. There is no
-- foreign key to wilson.card_events, which has none of its own either, and
-- the fixture must outlive whatever happens to that log.
-- =========================================================================

CREATE TABLE wilson.eval_fixtures (
    id BIGSERIAL PRIMARY KEY,
    project TEXT NOT NULL,
    source_card_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    source_event_id BIGINT NOT NULL,
    plan_version_id TEXT NOT NULL,
    plan JSONB NOT NULL,
    base_sha TEXT NOT NULL,
    head_sha TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (project, source_event_id)
);

-- migrate:down

DROP TABLE wilson.eval_fixtures;
