-- migrate:up

-- =========================================================================
-- runner.hosts.kind: how the daemon reaches a host.
--
-- `ssh` is every host there has been so far: the daemon connects out with
-- `ssh <ssh_target>` and runs each command, and carries each git transfer,
-- over that connection.
--
-- `worker` is a host that connects in instead: a worker program on the
-- machine opens a connection to the API and carries out what the daemon sends
-- over it, so the daemon needs no route to the machine and no key for it. It
-- has no SSH target, which is why `ssh_target` is now set exactly when the
-- kind is `ssh`.
--
-- Not changeable once registered: a host's slots, leases and probe all
-- describe one way of reaching it. Moving a machine from one kind to the
-- other is removing the host and registering it again.
-- =========================================================================

ALTER TABLE runner.hosts ADD COLUMN kind TEXT NOT NULL DEFAULT 'ssh' CHECK (kind IN ('ssh', 'worker'));
ALTER TABLE runner.hosts ALTER COLUMN ssh_target DROP NOT NULL;
ALTER TABLE runner.hosts ADD CONSTRAINT hosts_ssh_target_matches_kind CHECK ((kind = 'ssh') = (ssh_target IS NOT NULL));

-- migrate:down

-- A worker host has no SSH target to keep, so it cannot survive `ssh_target`
-- becoming required again; it goes, and its projects with it by cascade.
DELETE FROM runner.hosts WHERE kind = 'worker';
ALTER TABLE runner.hosts DROP CONSTRAINT hosts_ssh_target_matches_kind;
ALTER TABLE runner.hosts ALTER COLUMN ssh_target SET NOT NULL;
ALTER TABLE runner.hosts DROP COLUMN kind;
