-- migrate:up

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
