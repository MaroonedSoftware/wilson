-- migrate:up

-- The question a stage stopped to ask, while it waits for an answer: `category`, `tried`, `question`,
-- `options`, `stage`, `askedAt` and, when the run left uncommitted work, `patchPath`. The card also
-- carries `needs_human`, with the question as its reason. NULL for a card with no question waiting.
ALTER TABLE wilson.cards ADD COLUMN blocked JSONB;

-- migrate:down

ALTER TABLE wilson.cards DROP COLUMN blocked;
