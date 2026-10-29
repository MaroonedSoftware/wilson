-- migrate:up

-- =========================================================================
-- runner.accounts and runner.account_passwords: the operator account
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
-- A username rather than an email address: signing in needs no mail
-- setup, and there is nobody else to tell apart.
--
-- Passwords are one row per account, keyed by it, as
-- @maroonedsoftware/authentication's PasswordFactorRepository expects.
-- `hash` is Argon2id's encoded form; `salt` is what the library hands
-- back alongside it.
-- =========================================================================

CREATE TABLE runner.accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username TEXT NOT NULL CHECK (length(username) BETWEEN 1 AND 64),
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX accounts_one_row ON runner.accounts ((true));
CREATE UNIQUE INDEX accounts_username_lower ON runner.accounts (lower(username));

CREATE TABLE runner.account_passwords (
    account_id UUID PRIMARY KEY REFERENCES runner.accounts (id),
    hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT true,
    needs_reset BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- migrate:down

DROP TABLE runner.account_passwords;
DROP TABLE runner.accounts;
