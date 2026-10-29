-- migrate:up

-- =========================================================================
-- runner.hosts.worker_token_*: the one credential a worker host's worker
-- program connects with.
--
-- Only the SHA-256 of the token is kept, as `runner.api_keys` keeps its
-- secrets: the token is shown once when it is minted and never again.
-- `worker_token_hint` is its last four characters, so an operator can tell
-- which token a machine holds without the row giving it away.
--
-- One per host, and minting another replaces it: a worker host is one
-- machine, so there is never a second worker to keep a second token for.
-- Only the worker connection endpoint accepts one, and it names exactly
-- one host, so a stolen token can pose as that host and do nothing else.
-- =========================================================================

ALTER TABLE runner.hosts ADD COLUMN worker_token_hash TEXT UNIQUE;
ALTER TABLE runner.hosts ADD COLUMN worker_token_hint TEXT;
ALTER TABLE runner.hosts ADD COLUMN worker_token_issued_at TIMESTAMPTZ;
ALTER TABLE runner.hosts ADD CONSTRAINT hosts_worker_token_only_for_workers CHECK (worker_token_hash IS NULL OR kind = 'worker');
ALTER TABLE runner.hosts ADD CONSTRAINT hosts_worker_token_whole CHECK (
    (worker_token_hash IS NULL) = (worker_token_hint IS NULL)
    AND (worker_token_hash IS NULL) = (worker_token_issued_at IS NULL)
);

-- migrate:down

ALTER TABLE runner.hosts DROP CONSTRAINT hosts_worker_token_whole;
ALTER TABLE runner.hosts DROP CONSTRAINT hosts_worker_token_only_for_workers;
ALTER TABLE runner.hosts DROP COLUMN worker_token_issued_at;
ALTER TABLE runner.hosts DROP COLUMN worker_token_hint;
ALTER TABLE runner.hosts DROP COLUMN worker_token_hash;
