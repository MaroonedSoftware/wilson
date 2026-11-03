-- migrate:up

-- How a card ended, once it has: merged, poisoned, dropped or split. NULL for a card still on the board.
ALTER TABLE wilson.cards ADD COLUMN done_reason TEXT;

UPDATE wilson.cards SET done_reason = stage WHERE stage IN ('merged', 'poisoned', 'dropped', 'split');

-- migrate:down

ALTER TABLE wilson.cards DROP COLUMN done_reason;
