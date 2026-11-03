-- migrate:up

-- =========================================================================
-- wilson.reviews — one person's pass over a card's branch at one commit.
--
-- A planning session needs no table, because its identity is the card. A
-- review's identity includes the commit it read and the verdict it reached, so
-- a branch that moves on gets a new row and the old one stays on record.
-- At most one is open per card.
-- =========================================================================

CREATE TABLE wilson.reviews (
    id BIGSERIAL PRIMARY KEY,
    project TEXT NOT NULL,
    card_id TEXT NOT NULL,
    head_sha TEXT NOT NULL,
    base_sha TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'changes_requested', 'approved', 'superseded')),
    verdict_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (project, card_id) REFERENCES wilson.cards (project, id) ON DELETE CASCADE
);

CREATE INDEX reviews_project_card_id_idx ON wilson.reviews (project, card_id, id);
CREATE UNIQUE INDEX reviews_one_open_per_card_idx ON wilson.reviews (project, card_id) WHERE status = 'open';

-- =========================================================================
-- wilson.review_comments — a comment left on one line of a card's diff.
--
-- Belongs to the card as well as the review it was written in, because comments
-- outlive a review: a later one re-locates them against its own commit. The
-- anchor is the line's text and its neighbours, never only a number, since a
-- rebase moves lines and leaves the old commit unreachable. Whether a comment
-- still locates is answered at read time (`review.anchor.ts`) and never stored.
-- =========================================================================

CREATE TABLE wilson.review_comments (
    id BIGSERIAL PRIMARY KEY,
    project TEXT NOT NULL,
    card_id TEXT NOT NULL,
    review_id BIGINT NOT NULL REFERENCES wilson.reviews (id) ON DELETE CASCADE,
    head_sha TEXT NOT NULL,
    file TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('old', 'new')),
    line INTEGER NOT NULL,
    line_text TEXT NOT NULL,
    context_before TEXT[] NOT NULL DEFAULT '{}',
    context_after TEXT[] NOT NULL DEFAULT '{}',
    severity TEXT NOT NULL DEFAULT 'blocker' CHECK (severity IN ('blocker', 'concern')),
    text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'sent')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (project, card_id) REFERENCES wilson.cards (project, id) ON DELETE CASCADE
);

CREATE INDEX review_comments_project_card_id_idx ON wilson.review_comments (project, card_id, id);

-- migrate:down

DROP TABLE wilson.review_comments;
DROP TABLE wilson.reviews;
