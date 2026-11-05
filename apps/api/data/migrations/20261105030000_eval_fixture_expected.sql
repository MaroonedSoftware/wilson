-- migrate:up

-- =========================================================================
-- wilson.eval_fixtures.expected — what a review of this attempt should find.
--
-- A review's verifier checks that its report is coherent, not that it is
-- right, so a review that passes everything would score perfectly on that
-- alone. Empty for a stage with nothing to compare against. `source` says
-- whether it was read off what the card's own review concluded or a person
-- set it, since only the second is more than the model agreeing with itself.
-- =========================================================================

ALTER TABLE wilson.eval_fixtures ADD COLUMN expected JSONB;

-- migrate:down

ALTER TABLE wilson.eval_fixtures DROP COLUMN expected;
