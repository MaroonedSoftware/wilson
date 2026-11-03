-- migrate:up

-- Where an approved plan's scope check has got to: 'checking' while it runs, 'refused' once it has
-- said no. The card sits in planning for both. NULL for a card with no check under way.
ALTER TABLE wilson.cards ADD COLUMN plan_check TEXT;
ALTER TABLE wilson.cards ADD COLUMN plan_check_reason TEXT;

-- migrate:down

ALTER TABLE wilson.cards DROP COLUMN plan_check_reason;
ALTER TABLE wilson.cards DROP COLUMN plan_check;
