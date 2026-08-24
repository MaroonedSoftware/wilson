-- migrate:up

-- =========================================================================
-- A card can say it needs a human, without moving.
--
-- Today the only way to flag a card for attention is to route it to the
-- `needs-human` lane, which loses the stage it failed in and makes the card
-- terminal so its worktree is reclaimed. These columns are the replacement:
-- a property a card carries wherever it sits, so it can stay in its stage
-- and keep its tree. Nothing reads these columns yet — the lane still
-- exists and still behaves exactly as it does today.
-- =========================================================================

ALTER TABLE runner.cards
    -- A person has to look at this card before it runs again.
    ADD COLUMN needs_human BOOLEAN NOT NULL DEFAULT FALSE,
    -- What the runner or the operator said when they set the flag.
    ADD COLUMN needs_human_reason TEXT;

-- migrate:down

ALTER TABLE runner.cards
    DROP COLUMN needs_human,
    DROP COLUMN needs_human_reason;
