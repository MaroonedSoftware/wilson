-- migrate:up

-- =========================================================================
-- runner.accounts: the operator account signs in with an email address,
-- not a username (PROJECT.md, Authentication).
--
-- Still no mail setup: wilson never sends to the address, so it is only
-- the name the operator signs in with. The check is a shape check, not
-- validation; the API's contract checks the format before a row is written.
-- 254 is the longest address SMTP's path limit allows.
--
-- Renamed rather than added beside: the column was added the same day,
-- before any deployment created an account, so there is no username to
-- carry over and no reason to keep both.
-- =========================================================================

ALTER TABLE runner.accounts RENAME COLUMN username TO email;
ALTER TABLE runner.accounts DROP CONSTRAINT accounts_username_check;
ALTER TABLE runner.accounts
    ADD CONSTRAINT accounts_email_check CHECK (length(email) BETWEEN 3 AND 254 AND position('@' IN email) > 1);
ALTER INDEX runner.accounts_username_lower RENAME TO accounts_email_lower;

-- migrate:down

ALTER INDEX runner.accounts_email_lower RENAME TO accounts_username_lower;
ALTER TABLE runner.accounts DROP CONSTRAINT accounts_email_check;
ALTER TABLE runner.accounts RENAME COLUMN email TO username;
ALTER TABLE runner.accounts ADD CONSTRAINT accounts_username_check CHECK (length(username) BETWEEN 1 AND 64);
