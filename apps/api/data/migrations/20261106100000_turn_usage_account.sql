-- migrate:up

-- Which engine account a chat or planning turn's tokens were spent on: a saved token's name, `local`, or
-- `worker:<host>`, as `EngineAccountsService` names them. Stage events carry the same in their payload.
-- Null for a turn recorded before this, and for an engine that signs in with no account, such as `api`.
ALTER TABLE wilson.chat_turn_usage ADD COLUMN account TEXT;
ALTER TABLE wilson.plan_turns ADD COLUMN account TEXT;

-- migrate:down

ALTER TABLE wilson.chat_turn_usage DROP COLUMN account;
ALTER TABLE wilson.plan_turns DROP COLUMN account;
