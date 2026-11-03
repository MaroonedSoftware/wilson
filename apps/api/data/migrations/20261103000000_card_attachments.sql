-- migrate:up

-- =========================================================================
-- wilson.card_attachments — an image kept on a card (split from card 0006).
--
-- Rows, not files: the database is operator-private by construction and the
-- code repo is the one that gets shared, so an attachment never touches the
-- worktree. A sibling of wilson.card_context rather than a wider version of
-- it, because that table's `content` is TEXT and must not be made to hold
-- base64.
--
-- `content_type` is the type sniffed from the bytes, never the one the
-- uploader declared. `filename` only decorates the row: `id` is its identity,
-- and nothing builds a path from the name. The per-file and per-card caps are
-- the application's (`attachment.bytes.ts`), so they can change without a
-- migration.
-- =========================================================================

CREATE TABLE wilson.card_attachments (
    id BIGSERIAL PRIMARY KEY,
    project TEXT NOT NULL,
    card_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    content_type TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    bytes BYTEA NOT NULL,
    added_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (project, card_id) REFERENCES wilson.cards (project, id) ON DELETE CASCADE
);

CREATE INDEX card_attachments_project_card_id_idx ON wilson.card_attachments (project, card_id, id);

-- migrate:down

DROP TABLE wilson.card_attachments;
