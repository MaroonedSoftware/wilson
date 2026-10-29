-- migrate:up

-- =========================================================================
-- runner.account_authenticators: authenticator apps (TOTP) enrolled as a
-- second factor for the operator account (PROJECT.md, Authentication).
--
-- `secret` is the TOTP seed encrypted under the root key
-- (AUTH_ENCRYPTION_KEY, encryption.key.ts) by the authentication library;
-- a code can only be checked against the seed itself, so unlike a
-- password it cannot be hashed. `counter` is the replay guard's high-water
-- mark, advanced by every code that validates, so one code works once.
--
-- Removing an authenticator sets `active` false rather than deleting it.
-- =========================================================================

CREATE TABLE runner.account_authenticators (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES runner.accounts (id),
    secret TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('totp', 'hotp')),
    algorithm TEXT NOT NULL CHECK (algorithm IN ('sha1', 'sha256', 'sha512')),
    token_length INT NOT NULL CHECK (token_length >= 6),
    period_seconds INT NOT NULL CHECK (period_seconds >= 30),
    counter INT NOT NULL DEFAULT 0 CHECK (counter >= 0),
    label TEXT,
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX account_authenticators_account ON runner.account_authenticators (account_id);

-- migrate:down

DROP TABLE runner.account_authenticators;
