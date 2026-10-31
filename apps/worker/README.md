# Wilson worker

The program that lets a machine run Wilson's card stages without Wilson connecting to it. The worker
connects out to Wilson's API, and Wilson sends it file and command work over that one connection:
reading and writing the card's worktree, running its build and tests, and starting the `claude`
engine. The model's code runs here, on the worker's machine. Wilson keeps the tool guard, the budgets,
the verification and the board.

Run it on a machine kept for the purpose (a VM is ideal). Everything a stage runs can touch whatever
the worker's user can. The worker refuses file work outside its host's project folders, but that is a
guardrail, not a boundary: a command run inside a project folder can still reach past it.

## What it needs on the machine

- Node 22 or later, pnpm, and git.
- `claude` (Claude Code) on `PATH`, at the version Wilson's engine probes pass on. `wilson host probe`
  reports a different one.
- A clone of each project it will serve, plus whatever toolchain those projects' setup and test
  commands use. A project with a GitHub repository needs no clone in place: the first stage placed
  here clones it through Wilson's GitHub App, with a short-lived token that is not kept.

## Setting one up

1. On Wilson, register the host as a worker and mint its token:

    ```bash
    wilson host add unraid-vm --worker --slots 2
    wilson host token unraid-vm
    ```

    The token is printed once. Minting another replaces it.

2. Tell Wilson where each project lives on the worker's machine:

    ```bash
    wilson host serve unraid-vm wilson --code-root /srv/wilson --worktree-root /srv/worktrees --run-root /srv/run
    ```

3. Give the host an engine token. Save one on Wilson once, from `claude setup-token`, then assign it:

    ```bash
    wilson engine-token set pool-a
    wilson host engine-token unraid-vm pool-a
    ```

4. Start the worker from a checkout of this repository on its machine:

    ```bash
    WILSON_URL=http://tower:13101 WILSON_WORKER_TOKEN=wilson_worker_... pnpm --filter @wilson/worker start
    ```

5. Back on Wilson, `wilson host probe unraid-vm` should pass. Stages placed `remote` or `any` can now
   land on it.

A VM built from `infra/vm-image` needs none of this by hand except the registration: it runs the worker
at boot and reads its token from Secret Manager. Register it with the VM's own name and a projects root,
and any project with a GitHub repository can run there with no `wilson host serve`:

```bash
wilson host add wilson-1 --worker --projects-root /srv/wilson
```

## Running it in Docker

The `worker` image holds a stage to one container: what it runs can touch the container and its
`/srv/projects` volume, not the machine's files. Stages then run on Linux, whatever the machine is. It
needs no inbound port. Never mount the Docker socket, a home folder or `~/.ssh` into it: any of them
undoes this.

The network is not contained. A stage can still reach whatever the machine can, and it holds the
engine's token.

1. On Wilson, register the host with a projects root inside the container, and mint its token:

    ```bash
    wilson host add my-mac --worker --projects-root /srv/projects
    wilson host token my-mac
    wilson host engine-token my-mac pool-a
    ```

2. On the machine, from a checkout of this repository, put the two variables in `worker.env`, which
   git ignores:

    ```bash
    WILSON_URL=http://tower:13101
    WILSON_WORKER_TOKEN=wilson_worker_...
    ```

3. Build and start it, then run `wilson host probe my-mac` on Wilson:

    ```bash
    docker compose -f docker-compose.worker.yml up --build -d
    ```

The image has Node, pnpm and git. A project that needs more names it at build time, with
`WORKER_PACKAGES="build-essential python3"` in the environment of that command. A project without a
GitHub repository cannot be cloned into the volume, so it does not suit this image.

Docker has no restart policy for "not after status 1", so the compose file gives up after five
restarts. After a refused token, `docker compose logs` says why.

## Environment

| Variable                  | Required | What it is                                                                        |
| ------------------------- | -------- | --------------------------------------------------------------------------------- |
| `WILSON_URL`              | yes      | Wilson's address, e.g. `http://tower:13101`                                       |
| `WILSON_WORKER_TOKEN`     | yes      | This host's token, from `wilson host token <name>`                                |
| `CLAUDE_CODE_OAUTH_TOKEN` | no       | The fallback when Wilson assigns no token. Unset, `claude`'s own sign-in is used. |
| `WILSON_CLAUDE`           | no       | The `claude` binary, when it is not the one on `PATH`                             |

## The engine's token

Wilson holds named tokens, encrypted, and sends the one assigned to this host with each engine start.
The worker gives it to that process and keeps no copy, so an idle worker holds none. In order, the
engine signs in with the assigned token, then `CLAUDE_CODE_OAUTH_TOKEN`, then `claude`'s own sign-in.

- **To rotate,** run `wilson engine-token set <name>` again. The next engine started on each host using
  it gets the new one, and no other token is touched.
- **To revoke,** run `wilson engine-token remove <name>`. That host falls back as above. An engine
  already running keeps the token, and this only makes Wilson forget it: revoke it with Anthropic too.
- **Use `https` for `WILSON_URL`** unless the network is private. Over `http` the token crosses the
  network in clear, and the worker logs a warning.

Stages on this host can get its token. It is kept out of the environment of configured commands and
Wilson's `bash` tool, and of anything that inherits the worker's own environment, but the engine's
built-in Bash tool hands its environment on, and any process running as this user can read the engine's
from `/proc`. So a stage on a host holds that host's token, and nothing stops hostile code using it. Give
hosts that run different trust levels different tokens, so that replacing one leaves the others alone.

## Keeping it running

The worker reconnects by itself, backing off up to 30 seconds, whenever Wilson restarts or the
network drops. Any process a stage started is killed when its connection drops; the stage is retried.

It exits for good, with status 1, when retrying cannot help: Wilson refused the token, speaks another
protocol version, or another worker connected as the same host. A supervisor (systemd, launchd,
Unraid's User Scripts) should restart it on other exits but not that one. With systemd:

```ini
[Service]
Environment=WILSON_URL=http://tower:13101
EnvironmentFile=/etc/wilson-worker.env
WorkingDirectory=/opt/wilson
ExecStart=/usr/bin/pnpm --filter @wilson/worker start
Restart=on-failure
RestartPreventExitStatus=1
```

with `WILSON_WORKER_TOKEN` in `/etc/wilson-worker.env`, readable by root only.
