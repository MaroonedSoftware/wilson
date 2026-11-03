-- migrate:up

-- =========================================================================
-- A review's conversation with the agent walking the person through it.
--
-- Not `wilson.plan_turns`, whose key is one conversation per card: a card has
-- one review per commit, and each starts its conversation fresh. A stored turn
-- holds what was typed and what was answered, never what the server prepended
-- to the prompt, as `plan_turns` does.
--
-- `comments_seen_id` is the newest comment the conversation has been told about,
-- so each comment reaches the agent once. `output_tokens` is there because
-- these turns are not stage events, and so count against no daily ceiling: this
-- is what makes their cost visible.
-- =========================================================================

ALTER TABLE wilson.reviews
    ADD COLUMN engine_session_id TEXT,
    ADD COLUMN comments_seen_id BIGINT NOT NULL DEFAULT 0;

CREATE TABLE wilson.review_turns (
    review_id BIGINT NOT NULL REFERENCES wilson.reviews (id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    output_tokens INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (review_id, seq)
);

-- migrate:down

DROP TABLE wilson.review_turns;
ALTER TABLE wilson.reviews DROP COLUMN comments_seen_id, DROP COLUMN engine_session_id;
