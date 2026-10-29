-- migrate:up

-- =========================================================================
-- runner.chat_threads, runner.chat_messages, runner.chat_pending_actions —
-- the chat a person drives Wilson from.
--
-- Modelled on ats's web chat: the agent reads freely through the operation
-- catalog (McpModule), but never changes anything itself. A change it wants
-- to make is stored as a pending action — the operation and its exact
-- arguments — and runs only when the person confirms it. This migration
-- only gives threads, messages and those actions somewhere to live;
-- nothing writes to them yet.
--
-- Not project-scoped. The chat sits on every page, the project-less
-- dashboard included, and one conversation can touch several projects, so
-- a thread has no `project` column and no FK into runner.cards. A pending
-- action records the project its operation runs in instead (null for an
-- operation that names none, such as registering a project).
--
-- A thread stays on the engine it started on (`engine`: 'api' is the AI
-- SDK, 'cli' the Claude Agent SDK, as `StageConfig.adapter` spells them).
-- The two keep history differently — 'api' replays stored messages every
-- turn, 'cli' resumes its own session by `engine_session_id` — so moving a
-- thread between them would mean rebuilding one from the other.
--
-- `archived_at` is a state, not a delete, the same reasoning as
-- runner.plan_comments' `resolved`: an archived thread is out of the list,
-- not gone.
-- =========================================================================

CREATE TABLE runner.chat_threads (
    id BIGSERIAL PRIMARY KEY,
    -- Named after the first message; the person may rename it.
    title TEXT NOT NULL,
    engine TEXT NOT NULL CHECK (engine IN ('api', 'cli')),
    -- The 'cli' engine's own session id, once a turn has reported one.
    engine_session_id TEXT,
    archived_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Moves with every message, so the list reads most recent first.
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX chat_threads_updated_at_idx ON runner.chat_threads (updated_at DESC) WHERE archived_at IS NULL;

-- One row per message, numbered per thread the way runner.plan_turns is.
--
-- `content` is what the person reads: their text, or the agent's answer.
-- `operations` is what the agent ran during an answer — each catalog
-- operation's name, arguments and whether it succeeded — so the chat can
-- show its working; '[]' on a person's message. `engine_messages` is the
-- 'api' engine's own record of the turn (the AI SDK's response messages,
-- tool calls and results included), replayed on its next turn so the
-- model keeps what it read; null for 'cli', whose session already holds it.
CREATE TABLE runner.chat_messages (
    thread_id BIGINT NOT NULL REFERENCES runner.chat_threads (id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    operations JSONB NOT NULL DEFAULT '[]'::JSONB,
    engine_messages JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (thread_id, seq)
);

-- A change the agent proposed, waiting on the person.
--
-- `operation` is a catalog operation's name and `arguments` exactly what
-- it will be called with; `summary` is the sentence the person is asked to
-- confirm. Only the person's decision runs it: `status` moves pending ->
-- running before the operation is called, in one conditional UPDATE, so a
-- double-clicked confirm runs it at most once, then -> done or failed with
-- its `result` or `error`. A decline moves pending -> declined. Past
-- `expires_at` a pending action can no longer be confirmed; that is read
-- off the timestamp rather than written back as a status, so nothing has
-- to sweep the table.
CREATE TABLE runner.chat_pending_actions (
    id BIGSERIAL PRIMARY KEY,
    thread_id BIGINT NOT NULL REFERENCES runner.chat_threads (id) ON DELETE CASCADE,
    project TEXT,
    operation TEXT NOT NULL,
    arguments JSONB NOT NULL,
    summary TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed', 'declined')),
    result JSONB,
    error TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    decided_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX chat_pending_actions_thread_id_idx ON runner.chat_pending_actions (thread_id, id);

-- migrate:down

DROP TABLE runner.chat_pending_actions;
DROP TABLE runner.chat_messages;
DROP TABLE runner.chat_threads;
