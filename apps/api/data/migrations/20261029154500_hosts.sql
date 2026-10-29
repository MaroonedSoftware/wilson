-- migrate:up

-- =========================================================================
-- runner.hosts: machines other than the daemon's own that a card stage can
-- run on, reached over SSH. TGA's agent VMs (`agent-1` to `agent-8`, made by
-- infra/agents/scripts/agent_vm.sh) are the first, but nothing here is
-- specific to them: a host is anything `ssh <ssh_target>` reaches without a
-- prompt.
--
-- Deployment-scoped like `runner.projects`, not per project: one machine can
-- serve several projects, and a host's slots are shared by every project
-- placing work on it. Which projects a host can serve, and where each one's
-- clone lives on it, is `runner.host_projects` below.
--
-- `enabled` and `draining` are both operator switches, and different ones.
-- A disabled host takes no new stage and is not probed. A draining host takes
-- no new stage either, but the stages already on it run to the end: it is how
-- an operator empties a VM before it is deleted, where disabling is how they
-- take one out of consideration altogether.
--
-- The `probe_*`, `engine_version` and `expires_at` columns are what the last
-- probe found, written only by the probe. They describe the machine as it
-- was then, not as it is: a VM deleted after a good probe still reads as
-- good until the next one. `expires_at` is when the host will stop by itself
-- (an agent VM is deleted 12 hours after it boots); null means it was not
-- reported, not that the host lasts forever.
-- =========================================================================

CREATE TABLE runner.hosts (
    name TEXT PRIMARY KEY,
    ssh_target TEXT NOT NULL,
    -- How many stages may run on the host at once. The same 1 to 8 range
    -- `card-stage-concurrency` allows, for the same reason: each slot is a
    -- worktree, an install and a Claude process on one machine.
    slots INTEGER NOT NULL DEFAULT 1 CHECK (slots BETWEEN 1 AND 8),
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    draining BOOLEAN NOT NULL DEFAULT FALSE,
    probed_at TIMESTAMPTZ,
    probe_ok BOOLEAN,
    probe_detail TEXT,
    engine_version TEXT,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =========================================================================
-- runner.host_projects: a project a host can serve, and the three paths it
-- needs there. The same three `runner.projects` carries for the daemon's own
-- machine, but on the host: `code_root` is a clone of the project's repo on
-- that machine, and the worktree and run roots are where a card's worktree
-- and its materialized plan go there.
--
-- No row, no work: a host serves only the projects listed for it. An agent
-- VM is signed in to GitHub with a token for one repository, so "every
-- project" is never true of one by default.
-- =========================================================================

CREATE TABLE runner.host_projects (
    host TEXT NOT NULL REFERENCES runner.hosts (name) ON DELETE CASCADE,
    project TEXT NOT NULL REFERENCES runner.projects (name) ON DELETE CASCADE,
    code_root TEXT NOT NULL,
    worktree_root TEXT NOT NULL,
    run_root TEXT NOT NULL,
    PRIMARY KEY (host, project)
);

-- migrate:down

DROP TABLE runner.host_projects;
DROP TABLE runner.hosts;
