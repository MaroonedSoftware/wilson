-- migrate:up

-- =========================================================================
-- Named Claude engine tokens, so a token can be replaced or removed without
-- touching any other. `ciphertext` is the token under the same root key as
-- the TOTP seeds and the `engine-oauth-token` setting: a dump holds nothing a
-- reader can sign in with.
-- =========================================================================

CREATE TABLE wilson.engine_tokens (
    name TEXT PRIMARY KEY,
    ciphertext TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- migrate:down

DROP TABLE wilson.engine_tokens;
