-- migrate:up

-- The GitHub pull request Merge opened for the card, when the project lands merges as pull requests:
-- `number`, `url` and `state` (`open`, `closed` or `merged`). Kept after the card reaches `merged`,
-- as the record of where its work went. NULL for a card no merge has opened one for.
ALTER TABLE wilson.cards ADD COLUMN pull_request JSONB;

-- migrate:down

ALTER TABLE wilson.cards DROP COLUMN pull_request;
