-- migrate:up

-- =========================================================================
-- wilson.card_events — the operational record.
--
-- Append-only: every claim, tool denial, scope grant, verification result and
-- transition lands here and nothing ever updates or deletes a row. The card
-- file in the board repo is the durable record; this table is what the runner
-- reads to answer "what happened", and (from step 3) to recover after a crash.
--
-- No foreign key to a cards table because there isn't one: cards live in the
-- board repo as markdown, and Postgres holds no copy of them. `project` and
-- `card_id` are the board coordinates, carried as text on purpose so a board
-- format change cannot orphan history.
-- =========================================================================

CREATE TABLE wilson.card_events (
    id BIGSERIAL PRIMARY KEY,
    project TEXT NOT NULL,
    card_id TEXT NOT NULL,
    stage TEXT,
    type TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The read pattern is always "the tail of one card's log, in order".
CREATE INDEX card_events_project_card_id_idx ON wilson.card_events (project, card_id, id);

-- migrate:down

DROP TABLE wilson.card_events;
