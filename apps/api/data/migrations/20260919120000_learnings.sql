-- migrate:up

-- =========================================================================
-- wilson.learnings — the project's human-approved learnings document.
--
-- Card 0239. A lesson one card paid for is gone by the next: a stage agent
-- sees the plan, the repo and its stage's `instructions`, and nothing else.
-- Context snapshots (20260902120000_card_context.sql) do not help — they are
-- per card, and they reach only the planning conversation. This table holds
-- one markdown document per project that the runner hands to every stage
-- agent (materialised beside `plan.md`, outside the worktree) and to the
-- first turn of every planning session.
--
-- The same shape as wilson.stage_configs (20260901120000_stage_configs.sql),
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
