-- migrate:up

-- =========================================================================
-- runner.hosts.lifetime_minutes: how long a host runs after it boots before
-- it stops by itself, when it does. TGA's agent VMs are deleted by Compute
-- Engine 12 hours after they start (`max_run_duration` in infra/agents), so
-- theirs is 720.
--
-- The probe reads the host's boot time and adds this to report `expires_at`,
-- which placement uses to keep a stage off a host that will be gone before
-- the stage could finish. A host cannot report this itself in any portable
-- way, which is why it is the operator's to set. Null is a host with no
-- known end.
-- =========================================================================

ALTER TABLE runner.hosts ADD COLUMN lifetime_minutes INTEGER CHECK (lifetime_minutes > 0);

-- migrate:down

ALTER TABLE runner.hosts DROP COLUMN lifetime_minutes;
