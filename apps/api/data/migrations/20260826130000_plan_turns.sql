-- migrate:up

-- =========================================================================
-- wilson.plan_turns — the append-only transcript of a planning conversation.
--
-- Card 0131: a planning conversation gets somewhere to live. This table is
-- what a later process appends a turn to and replays from on
-- `Last-Event-ID` reconnect — `seq` is that resume key, monotonic per
-- (project, card_id), not a timestamp and not a global sequence.
--
-- Deliberately not the record of the model's own context. The engine
-- resumes that itself, from its own session storage, keyed by
-- `engine_session_id` — this table exists for rendering the conversation
-- and for reconnect replay, not for rebuilding the model's prompt history.
--
-- `engine_session_id` is set on the assistant row a turn produced (the
-- only place the engine ever reports one) and left null on the user row
-- that prompted it; `PlanTurnRepository.latestEngineSessionId` reads the
-- most recent non-null value to resume from after a restart.
-- =========================================================================

CREATE TABLE wilson.plan_turns (
    project TEXT NOT NULL,
    card_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    engine_session_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (project, card_id, seq)
);

-- migrate:down

DROP TABLE wilson.plan_turns;
