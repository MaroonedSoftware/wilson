-- migrate:up

-- =========================================================================
-- runner.hosts.command_env: names of variables a host's own environment
-- supplies to the commands stage config runs there (setup, build, test,
-- format), and to nothing else.
--
-- Every command on a host starts from an empty environment (`env -i`), so a
-- secret the host's shell holds does not leak into a stage by accident. That
-- also strips what a configured command genuinely needs: a TGA agent VM's
-- `yarn install` reads GITHUB_TOKEN (a read:packages token,
-- infra/agents/README.md) from the environment its .bashrc sets up. Naming it
-- here passes the host's own value through, taken on the host, so it never
-- travels from this machine.
--
-- The agent's own tools and the engine never get these: a token that can
-- read packages is the setup command's business, not the agent's.
-- =========================================================================

ALTER TABLE runner.hosts ADD COLUMN command_env TEXT[] NOT NULL DEFAULT '{}';

-- migrate:down

ALTER TABLE runner.hosts DROP COLUMN command_env;
