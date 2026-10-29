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

-- =========================================================================
-- wilson.plan_comments — a comment on a passage of a plan draft.
--
-- Card 0122/0146: a comment on a passage has somewhere to live. What is
-- stored is exactly what [[0145]]'s `Anchor` captures — `quote` plus its
-- `prefix`/`suffix` window — never a character offset. The draft is
-- rewritten in full on every planning turn (PROJECT.md's "Interactive
-- planning"), so a stored offset would be wrong by the very next revision;
-- whether a quote still locates in the current draft is asked at read
-- time, by `locateAnchor` (apps/web/src/lib/anchor.ts), never precomputed
-- and stored here.
--
-- `resolved` is a state, not a delete: a comment the agent addressed stays
-- on record rather than disappearing, so "what was said" remains a
-- question a person can ask later even after "is this still open" is
-- answered.
--
-- The comment thread itself is input, never contract — PROJECT.md is
-- explicit that open comments are handed to the agent as anchored
-- instructions and only the resulting plan text binds downstream stages.
-- This table is deliberately not `plan.md`, not a card version, and never
-- read by anything but `PlanService` and the endpoints this card adds.
-- =========================================================================

CREATE TABLE wilson.plan_comments (
    id BIGSERIAL PRIMARY KEY,
    project TEXT NOT NULL,
    card_id TEXT NOT NULL,
    -- The anchor: the quoted passage, plus the text immediately before and
    -- after it at capture time. See apps/web/src/lib/anchor.ts's `Anchor`.
    quote TEXT NOT NULL,
    prefix TEXT NOT NULL,
    suffix TEXT NOT NULL,
    -- What the person said about the quoted passage.
    text TEXT NOT NULL,
    resolved BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (project, card_id) REFERENCES wilson.cards (project, id) ON DELETE CASCADE
);

CREATE INDEX plan_comments_project_card_id_idx ON wilson.plan_comments (project, card_id, id);

-- =========================================================================
-- wilson.stage_configs — the stage configuration, in Postgres.
--
-- Until now the stage config was `config/stages.yaml` in the sibling board
-- repo: the last piece of board state still on disk after the cards moved
-- into Postgres (20261029000500_board.sql). This table replaces the file, and
-- the board repo's `git log` on it.
--
-- One row per write, append-only; the newest row for a project is its
-- current config. There is no separate "current" table the way cards have
-- `wilson.cards` beside `wilson.card_versions`, because a stage config has
-- no other mutable state to keep beside the document — the newest row *is*
-- the current state, and an `ORDER BY id DESC LIMIT 1` says so without an
-- upsert that could disagree with its own history.
--
-- `yaml` is the document verbatim, comments included, not columns per field.
-- The live file is some four hundred lines and most of it is commentary
-- explaining why each budget and route is what it is; that is the value of
-- the document, and a normalised schema would either drop it or need a
-- comment column per field. Validation is the same zod schema and route
-- check the file went through (`parseStages`, stage.config.ts), run on every
-- write and every read.
--
-- `message` is what the commit message on `stages.yaml` used to be — the
-- audit narrative, kept for the same reason `wilson.card_versions.message`
-- is: "Raise the review step budget to 150".
-- =========================================================================

CREATE TABLE wilson.stage_configs (
    id BIGSERIAL PRIMARY KEY,
    project TEXT NOT NULL,
    yaml TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX stage_configs_project_id_idx ON wilson.stage_configs (project, id DESC);

-- =========================================================================
-- wilson.learnings — the project's human-approved learnings document.
--
-- Card 0239. A lesson one card paid for is gone by the next: a stage agent
-- sees the plan, the repo and its stage's `instructions`, and nothing else.
-- Context snapshots (wilson.card_context) do not help — they are
-- per card, and they reach only the planning conversation. This table holds
-- one markdown document per project that the runner hands to every stage
-- agent (materialised beside `plan.md`, outside the worktree) and to the
-- first turn of every planning session.
--
-- The same shape as wilson.stage_configs above,
-- deliberately: one row per write, append-only, and the newest row for a
-- project is its current document. Both are a single human-owned document per
-- project that agents read and never write (PROJECT.md, decision 8), and both
-- want their history and a reason for every change more than they want an
-- upsert.
--
-- Not wilson.settings, which was the other candidate: a setting is one JSON
-- value per key with no history and no message, resolved through an env-var
-- fallback that a multi-page markdown document has no business round-tripping.
--
-- `markdown` is the document verbatim. Empty is a valid value — it is how the
-- operator retires every learning at once without deleting history — and the
-- runner treats an empty document the same as no row: nothing is materialised.
--
-- `message` is the audit narrative, as on wilson.stage_configs and
-- wilson.card_versions: "Agents keep reaching for `find`; it does not exist".
--
-- Written by hand ahead of card 0239 (card 0192: no stage carries migration
-- tooling), so the card's plan can assume the table.
-- =========================================================================

CREATE TABLE wilson.learnings (
    id BIGSERIAL PRIMARY KEY,
    project TEXT NOT NULL,
    markdown TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX learnings_project_id_idx ON wilson.learnings (project, id DESC);

-- migrate:down

DROP TABLE wilson.learnings;

DROP TABLE wilson.stage_configs;

DROP TABLE wilson.plan_comments;

DROP TABLE wilson.plan_turns;
