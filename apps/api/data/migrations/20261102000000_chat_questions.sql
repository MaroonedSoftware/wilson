-- migrate:up

-- =========================================================================
-- wilson.chat_questions — a structured question the chat's agent asked, waiting on the person.
--
-- A sibling table to wilson.chat_pending_actions (20261029000900_chat.sql), not a generalisation of
-- it: the two payloads do not share a shape (a change is one operation and its arguments, a question
-- is 1-4 prompts with their options), their status enums do not share a value in common beyond the
-- word "pending", and the two will grow their own UI independently. Merging them into one "pending
-- thing" table would couple those futures for no present gain.
--
-- `questions` is the 1-4 questions exactly as the agent asked them, options included; `answers` is
-- null until the person answers, then one entry per question, in the same order. `status` moves
-- pending -> answered when they submit, or pending -> dismissed when an ordinary message on the same
-- thread supersedes it (ChatService.sendMessage) — never swept, never a sequence. Past `expires_at`
-- a pending question can no longer be answered; that is read off the timestamp rather than written
-- back as a status, the same rule the sibling table's header comment states, so nothing has to sweep
-- this table either.
-- =========================================================================

CREATE TABLE wilson.chat_questions (
    id BIGSERIAL PRIMARY KEY,
    thread_id BIGINT NOT NULL REFERENCES wilson.chat_threads (id) ON DELETE CASCADE,
    questions JSONB NOT NULL, -- the 1-4 questions as asked, with their options
    answers JSONB, -- null until answered; one entry per question, in order
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'answered', 'dismissed')),
    expires_at TIMESTAMPTZ NOT NULL,
    decided_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX chat_questions_thread_id_idx ON wilson.chat_questions (thread_id, id);

-- migrate:down

DROP TABLE wilson.chat_questions;
