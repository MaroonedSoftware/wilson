-- migrate:up

-- What the agent offered to ask next after an answer (`chat.suggestions.ts`), taken off `content`
-- and kept beside it. '[]' on a person's message, and on an answer that offered none.
ALTER TABLE wilson.chat_messages ADD COLUMN suggestions JSONB NOT NULL DEFAULT '[]'::JSONB;

-- migrate:down

ALTER TABLE wilson.chat_messages DROP COLUMN suggestions;
