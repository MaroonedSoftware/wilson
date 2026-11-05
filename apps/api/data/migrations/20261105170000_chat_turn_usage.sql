-- migrate:up

-- =========================================================================
-- wilson.chat_turn_usage: what each chat turn cost.
--
-- A table of its own rather than a column on wilson.chat_messages, because a
-- turn that answers NOTHING_MORE stores no message and still spent tokens.
-- Append-only. An input count is null when the engine did not report one.
-- =========================================================================

CREATE TABLE wilson.chat_turn_usage (
    id BIGSERIAL PRIMARY KEY,
    thread_id BIGINT NOT NULL REFERENCES wilson.chat_threads (id) ON DELETE CASCADE,
    engine TEXT NOT NULL CHECK (engine IN ('api', 'cli')),
    model TEXT NOT NULL,
    input_tokens INTEGER,
    cached_input_tokens INTEGER,
    output_tokens INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX chat_turn_usage_thread_id_idx ON wilson.chat_turn_usage (thread_id, id);

-- migrate:down

DROP TABLE wilson.chat_turn_usage;
