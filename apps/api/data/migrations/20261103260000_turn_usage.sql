-- migrate:up

-- =========================================================================
-- What a planning or review turn spent, on the turn itself.
--
-- Not on `wilson.card_events`: a card's input budget sums the `usage` of every
-- event it has, and the daily ceiling reads stage events. These turns are held
-- to neither, so their cost is kept where neither looks. `input_tokens` leaves
-- out cached tokens, as a stage event's `usage` does. All of it is NULL on a
-- turn from before this, a person's own turn, and a turn the engine reported
-- nothing for.
-- =========================================================================

ALTER TABLE wilson.plan_turns
    ADD COLUMN input_tokens INTEGER,
    ADD COLUMN cached_input_tokens INTEGER,
    ADD COLUMN output_tokens INTEGER;

ALTER TABLE wilson.review_turns
    ADD COLUMN input_tokens INTEGER,
    ADD COLUMN cached_input_tokens INTEGER;

-- migrate:down

ALTER TABLE wilson.review_turns
    DROP COLUMN cached_input_tokens,
    DROP COLUMN input_tokens;

ALTER TABLE wilson.plan_turns
    DROP COLUMN output_tokens,
    DROP COLUMN cached_input_tokens,
    DROP COLUMN input_tokens;
