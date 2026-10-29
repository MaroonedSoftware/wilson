-- migrate:up

-- =========================================================================
-- runner.api_keys: the operator's API keys (PROJECT.md, Authentication).
--
-- A key is `wl_` plus a random body and a checksum, minted by
-- @maroonedsoftware/authentication's ApiKeyService. Only its SHA-256
-- (`secret_hash`) and a short display `hint` are stored: the token itself
-- is shown once, at creation or rotation, and cannot be recovered.
--
-- `scopes` is `view` or `manage` (manage implies view). A key never
-- outranks its owner, because a key's session is the owner's account and
-- every request through it checks that account is still active.
--
-- Revoking sets `revoked_at` rather than deleting, so the key list can
-- still say what a key was and when it stopped working.
-- =========================================================================

CREATE TABLE runner.api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES runner.accounts (id),
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
    type TEXT,
    hint TEXT NOT NULL,
    secret_hash TEXT NOT NULL UNIQUE,
    scopes TEXT[] NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
);

CREATE INDEX api_keys_account ON runner.api_keys (account_id);

-- migrate:down

DROP TABLE runner.api_keys;
