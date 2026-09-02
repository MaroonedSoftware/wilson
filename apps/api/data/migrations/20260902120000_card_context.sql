-- migrate:up

-- =========================================================================
-- runner.card_context — a snapshot of external context attached to a card.
--
-- First of six in the context-provider slice (PROJECT.md, "Context
-- providers"). Rows, not files: the database is operator-private by
-- construction and the code repo is the one that gets shared, so a
-- snapshot never touches the worktree. This card only gives the snapshot
-- somewhere to live; nothing writes to it yet. The `ContextProvider`
-- interface and the URL provider are the provider-seam card; the HTTP
-- surface is the contract card; reading these rows back is three later
-- cards again.
--
-- The manifest (`source_url`, `fetched_at`, `fetched_by`) is what a
-- provider reported about the fetch; the content (`title`, `content`,
-- `content_hash`) is what it fetched. The schema cannot enforce the
-- trimming rule that content must be message text, author display name
-- and timestamp only, never emails, account ids or attachments — that is
-- a constraint on what a provider produces, enforced by the provider-seam
-- card, not by a column here.
--
-- `fetched_at` and `created_at` are both present and are not redundant:
-- `fetched_at` is manifest data the provider reports — when the source
-- said the content was current — and `created_at` is when this row was
-- written. They will be milliseconds apart today, when every provider
-- fetches live, and would not be if a provider ever served a cached
-- fetch. Do not delete one for looking duplicate.
--
-- `content_hash` is declared now and read by nobody yet. The retention
-- card keeps it after expiring `content`, so a later reader can still
-- tell whether two now-expired snapshots held the same document. Adding
-- a column to a populated table is strictly more work than declaring it
-- here before this table holds any rows.
--
-- `remove` (`CardContextRepository`) is a real delete, not a `resolved`-
-- style state: unlike `runner.plan_comments`, a snapshot has no history
-- worth keeping once a person says it was the wrong document. That is a
-- different operation from retention's expiry, which keeps the manifest
-- and clears only the content.
-- =========================================================================

CREATE TABLE runner.card_context (
    id BIGSERIAL PRIMARY KEY,
    project TEXT NOT NULL,
    card_id TEXT NOT NULL,
    -- The manifest: what the provider reported about the fetch.
    source_url TEXT NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL,
    fetched_by TEXT NOT NULL,
    -- The content: what it fetched.
    title TEXT,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (project, card_id) REFERENCES runner.cards (project, id) ON DELETE CASCADE
);

CREATE INDEX card_context_project_card_id_idx ON runner.card_context (project, card_id, id);

-- migrate:down

DROP TABLE runner.card_context;
