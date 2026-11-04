-- migrate:up

-- =========================================================================
-- wilson.rule_proposals — a rule a model drafted from a blocker that survived
-- challenge and sent a card back, waiting on a person.
--
-- One row per card at most, claimed before the model is asked, so a card sent
-- back several times costs one draft. Status flow:
--
--   drafting -> pending   the model drafted one
--   drafting -> skipped   it found nothing worth a rule, or could not answer
--   pending  -> accepted  a person made it a rule, named in `rule`
--   pending  -> declined
--
-- A proposal nobody decides stops being offered at expires_at. Every move out of
-- 'pending' is one conditional UPDATE, so a decision is at-most-once.
-- =========================================================================

CREATE TABLE wilson.rule_proposals (
    id BIGSERIAL PRIMARY KEY,
    project TEXT NOT NULL,
    card_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('drafting', 'pending', 'skipped', 'accepted', 'declined')),
    statement TEXT,
    paths TEXT[],
    reason TEXT,
    rule TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    decided_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (project, card_id)
);

CREATE INDEX rule_proposals_pending_idx ON wilson.rule_proposals (project, expires_at) WHERE status = 'pending';

-- migrate:down

DROP TABLE wilson.rule_proposals;
