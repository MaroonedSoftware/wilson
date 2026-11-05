-- migrate:up

-- =========================================================================
-- wilson.secrets: named values the operator saves for Wilson to use on their
-- behalf. `ciphertext` is under the same root key as the engine tokens, so a
-- dump holds nothing a reader can use. Deployment-scoped, like engine tokens.
-- =========================================================================

CREATE TABLE wilson.secrets (
    name TEXT PRIMARY KEY CHECK (name ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
    ciphertext TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- migrate:down

DROP TABLE wilson.secrets;
