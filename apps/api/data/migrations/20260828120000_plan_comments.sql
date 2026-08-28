-- migrate:up

-- =========================================================================
-- runner.plan_comments — a comment on a passage of a plan draft.
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

CREATE TABLE runner.plan_comments (
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
    FOREIGN KEY (project, card_id) REFERENCES runner.cards (project, id) ON DELETE CASCADE
);

CREATE INDEX plan_comments_project_card_id_idx ON runner.plan_comments (project, card_id, id);

-- migrate:down

DROP TABLE runner.plan_comments;
