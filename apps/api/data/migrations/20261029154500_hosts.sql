-- migrate:up

-- =========================================================================
-- runner.hosts: machines other than the daemon's own that a card stage can
-- run on. TGA's agent VMs (`agent-1` to `agent-8`, made by
-- infra/agents/scripts/agent_vm.sh) are the first, but nothing here is
-- specific to them.
--
-- `kind` is how the daemon reaches a host. An `ssh` host is anything
-- `ssh <ssh_target>` reaches without a prompt: the daemon connects out and
-- runs each command, and carries each git transfer, over that connection. A
-- `worker` host connects in instead: a worker program on the machine opens a
-- connection to the API and carries out what the daemon sends over it, so the
-- daemon needs no route to the machine and no key for it. It has no SSH
-- target, which is why `ssh_target` is set exactly when the kind is `ssh`.
-- The kind is not changeable once registered: a host's slots, leases and
-- probe all describe one way of reaching it, so moving a machine from one
-- kind to the other is removing the host and registering it again.
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
    kind TEXT NOT NULL DEFAULT 'ssh' CHECK (kind IN ('ssh', 'worker')),
    ssh_target TEXT,
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
    -- How long the host runs after it boots before it stops by itself, when it
    -- does. TGA's agent VMs are deleted by Compute Engine 12 hours after they
    -- start (`max_run_duration` in infra/agents), so theirs is 720. The probe
    -- reads the host's boot time and adds this to report `expires_at`, which
    -- placement uses to keep a stage off a host that will be gone before the
    -- stage could finish. A host cannot report this itself in any portable
    -- way, which is why it is the operator's to set. Null is a host with no
    -- known end.
    lifetime_minutes INTEGER CHECK (lifetime_minutes > 0),
    -- Names of variables the host's own environment supplies to the commands
    -- stage config runs there (setup, build, test, format), and to nothing
    -- else. Every command on a host starts from an empty environment
    -- (`env -i`), so a secret the host's shell holds does not leak into a
    -- stage by accident; that also strips what a configured command genuinely
    -- needs, such as the GITHUB_TOKEN a TGA agent VM's `yarn install` reads
    -- (infra/agents/README.md). Naming it here passes the host's own value
    -- through, taken on the host, so it never travels from this machine. The
    -- agent's own tools and the engine never get these.
    command_env TEXT[] NOT NULL DEFAULT '{}',
    -- The one credential a worker host's worker program connects with. Only
    -- the SHA-256 of the token is kept, as `runner.api_keys` keeps its
    -- secrets: the token is shown once when it is minted and never again.
    -- `worker_token_hint` is its last four characters, so an operator can tell
    -- which token a machine holds without the row giving it away. One per
    -- host, and minting another replaces it. Only the worker connection
    -- endpoint accepts one, and it names exactly one host, so a stolen token
    -- can pose as that host and do nothing else.
    worker_token_hash TEXT UNIQUE,
    worker_token_hint TEXT,
    worker_token_issued_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT hosts_ssh_target_matches_kind CHECK ((kind = 'ssh') = (ssh_target IS NOT NULL)),
    CONSTRAINT hosts_worker_token_only_for_workers CHECK (worker_token_hash IS NULL OR kind = 'worker'),
    CONSTRAINT hosts_worker_token_whole CHECK (
        (worker_token_hash IS NULL) = (worker_token_hint IS NULL)
        AND (worker_token_hash IS NULL) = (worker_token_issued_at IS NULL)
    )
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
