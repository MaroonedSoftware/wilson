-- migrate:up

-- =========================================================================
-- wilson.accounts and wilson.account_passwords: the operator account
-- (PROJECT.md decision 10 and Authentication).
--
-- One human account, created by first-run onboarding. `accounts_one_row`
-- is what holds it to one: a unique index on a constant admits a single
-- row, so two racing onboarding requests cannot both succeed, and the
-- second gets a unique violation (409) instead of a second account. That
-- is the Non-goals' "single operator" stated where the data is, rather
-- than a check-then-insert behind an advisory lock. Multi-user would drop
-- this index and nothing else here.
--
-- The operator signs in with an email address, but there is still no mail
-- setup: wilson never sends to the address, so it is only the name the
-- operator signs in with. The check is a shape check, not validation; the
-- API's contract checks the format before a row is written. 254 is the
-- longest address SMTP's path limit allows.
--
-- Passwords are one row per account, keyed by it, as
-- @maroonedsoftware/authentication's PasswordFactorRepository expects.
-- `hash` is Argon2id's encoded form; `salt` is what the library hands
-- back alongside it.
-- =========================================================================

CREATE TABLE wilson.accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL CHECK (length(email) BETWEEN 3 AND 254 AND position('@' IN email) > 1),
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX accounts_one_row ON wilson.accounts ((true));
CREATE UNIQUE INDEX accounts_email_lower ON wilson.accounts (lower(email));

CREATE TABLE wilson.account_passwords (
    account_id UUID PRIMARY KEY REFERENCES wilson.accounts (id),
    hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT true,
    needs_reset BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

SELECT wilson.add_updated_at_trigger('wilson.account_passwords');

-- =========================================================================
-- wilson.api_keys: the operator's API keys (PROJECT.md, Authentication).
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

CREATE TABLE wilson.api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES wilson.accounts (id),
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

CREATE INDEX api_keys_account ON wilson.api_keys (account_id);

-- =========================================================================
-- wilson.account_authenticators: authenticator apps (TOTP) enrolled as a
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

CREATE TABLE wilson.account_authenticators (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES wilson.accounts (id),
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

CREATE INDEX account_authenticators_account ON wilson.account_authenticators (account_id);

-- =========================================================================
-- wilson.account_passkeys: passkeys (WebAuthn credentials) enrolled as a
-- second factor for the operator account (PROJECT.md, Authentication).
--
-- `public_key` is the credential's public key (a passkey's private key
-- never leaves the authenticator, so there is nothing secret here), and
-- `public_key_id` the credential id the browser presents. `counter` is the
-- authenticator's signature counter, which only goes up, so a cloned
-- credential replaying an old count is refused.
--
-- A passkey is bound to the origin it was made at: one made at the dev
-- web app (localhost) does not work at another WEB_ORIGINS host.
-- =========================================================================

CREATE TABLE wilson.account_passkeys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES wilson.accounts (id),
    public_key TEXT NOT NULL,
    public_key_id TEXT NOT NULL UNIQUE,
    counter BIGINT NOT NULL DEFAULT 0 CHECK (counter >= 0),
    label TEXT,
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX account_passkeys_account ON wilson.account_passkeys (account_id);

-- migrate:down

DROP TABLE wilson.account_passkeys;

DROP TABLE wilson.account_authenticators;

DROP TABLE wilson.api_keys;

DROP TABLE wilson.account_passwords;
DROP TABLE wilson.accounts;
