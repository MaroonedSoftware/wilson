-- migrate:up

-- =========================================================================
-- wilson.chat_attachments — an image sent in a chat.
--
-- A sibling of wilson.card_attachments rather than a wider version of it,
-- because the owner is a thread and a message, not a card. Rows, not files,
-- for that table's reason.
--
-- `message_seq` is empty from the upload until the message that carries the
-- image is stored: an image goes up first and the message names it. One that
-- no message ever claimed is removed by a later upload. There is no foreign
-- key to wilson.chat_messages, because the column starts empty and messages
-- are append-only; `thread_id` is what cascades.
--
-- `content_type` is the type sniffed from the bytes, and `filename` only
-- decorates the row. The caps are the application's, so they can change
-- without a migration.
-- =========================================================================

CREATE TABLE wilson.chat_attachments (
    id BIGSERIAL PRIMARY KEY,
    thread_id BIGINT NOT NULL REFERENCES wilson.chat_threads (id) ON DELETE CASCADE,
    message_seq INTEGER,
    filename TEXT NOT NULL,
    content_type TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    bytes BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX chat_attachments_thread_id_message_seq_idx ON wilson.chat_attachments (thread_id, message_seq, id);
CREATE INDEX chat_attachments_unclaimed_idx ON wilson.chat_attachments (created_at) WHERE message_seq IS NULL;

-- migrate:down

DROP TABLE wilson.chat_attachments;
