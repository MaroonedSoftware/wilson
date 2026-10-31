-- migrate:up

-- =========================================================================
-- The card a split piece was cut from. Set once, when `split` creates the
-- piece, and never written again, so `split_from` is absent from every card
-- that was not split out of another. Cards split before this column existed
-- stay null: their only record of the origin is prose in a version message.
--
-- RESTRICT for the same reason as `card_deps.depends_on_id`: a piece must not
-- lose the card it points at. The index is for finding an origin's pieces.
-- =========================================================================

ALTER TABLE wilson.cards ADD COLUMN split_from TEXT;

ALTER TABLE wilson.cards
    ADD CONSTRAINT cards_split_from_fkey
    FOREIGN KEY (project, split_from) REFERENCES wilson.cards (project, id) ON DELETE RESTRICT;

CREATE INDEX cards_project_split_from_idx ON wilson.cards (project, split_from) WHERE split_from IS NOT NULL;

-- migrate:down

DROP INDEX wilson.cards_project_split_from_idx;

ALTER TABLE wilson.cards DROP CONSTRAINT cards_split_from_fkey;

ALTER TABLE wilson.cards DROP COLUMN split_from;
