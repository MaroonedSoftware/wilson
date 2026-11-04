-- migrate:up

-- =========================================================================
-- wilson.rule_verdicts — what a judge said about one revision of a rule, against
-- one diff.
--
-- Keyed by the rule's revision and the hash of the diff it read, so asking again
-- about the same words and the same code costs nothing. 'unavailable' means no
-- answer: the engine failed, time ran out or the diff was too large. It never
-- blocks a card, is not reused, and a later answer replaces it.
--
-- card_id is the card the verdict was first asked for, NULL for one asked by
-- `wilson rules check`. Nothing relies on it: a card's own verdicts are in its
-- `rule.verdicts` events.
-- =========================================================================

CREATE TABLE wilson.rule_verdicts (
    id BIGSERIAL PRIMARY KEY,
    project TEXT NOT NULL,
    rule TEXT NOT NULL,
    rule_revision_id BIGINT NOT NULL REFERENCES wilson.rule_revisions (id),
    diff_hash TEXT NOT NULL,
    card_id TEXT,
    verdict TEXT NOT NULL CHECK (verdict IN ('pass', 'fail', 'unavailable')),
    file TEXT,
    line INTEGER,
    evidence TEXT NOT NULL,
    engine TEXT,
    model TEXT,
    usage JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (project, rule_revision_id, diff_hash)
);

-- migrate:down

DROP TABLE wilson.rule_verdicts;
