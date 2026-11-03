-- migrate:up

-- The ordered walk through a change that a review's agent wrote, replaced whole
-- each time it writes one. Belongs to the review because it is bound to that
-- review's commit: a new commit starts with none.
ALTER TABLE wilson.reviews ADD COLUMN tour JSONB;

-- migrate:down

ALTER TABLE wilson.reviews DROP COLUMN tour;
