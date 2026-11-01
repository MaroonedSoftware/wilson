# `infra/vm-image`: the Wilson VM image

The Compute Engine image a Wilson VM boots from, built with Packer. It is published to the `wilson`
image family, so whatever creates a VM asks for the family and gets the newest build.

It holds no project. A project's clone and its dependencies live on the VM's own disk, so one image
serves every project, and what a project needs beyond the list below it installs in its own setup
command.

| What                | Where                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------ |
| Ubuntu 24.04        | `ubuntu-2404-lts-amd64`                                                                                |
| Node 22, Corepack   | The system's Node, which the engine runs on. Corepack gives a project its yarn or pnpm                 |
| mise                | `/opt/mise`, with Node 20 and 24, Python 3.13 and Go. Reads `.tool-versions`, `mise.toml` and `.nvmrc` |
| Docker and Compose  | `docker.io`, `docker-compose-v2`                                                                       |
| git, psql, tmux, jq |                                                                                                        |
| Claude Code         | Pinned to `CLAUDE_BINARY_VERSION`, with its updater off                                                |
| Ops Agent           | Logs and metrics in Cloud Logging and Monitoring                                                       |
| Wilson worker       | `/opt/wilson`, as the `wilson-worker` service, running as the `wilson` user                            |
| Tailscale           | Joins a tailnet only when a key secret exists                                                          |

`gh` and GitHub credentials are left out on purpose: Wilson moves commits itself and never pushes to a
forge, so a stage has no need of them.

## Building

From a laptop, with Packer and `gcloud` installed and signed in:

```bash
brew install hashicorp/tap/packer
gcloud auth application-default login
infra/vm-image/build.sh
```

The build uses the agents network and account already in `toku-agents`, so it needs the same access as an agent user
plus rights to create instances and images in `toku-agents`. It counts as one more VM against that
project's quotas while it runs. It takes no token, since it clones nothing private.

`build.sh` reads the engine version from `apps/api/src/modules/agent/cli.engine.version.ts`. After
bumping `CLAUDE_BINARY_VERSION`, build a new image. `provision.sh` fails the build if the installed
version differs, or if a basic check of the toolchain does not pass.

## What a VM reads at boot

Before each start, `wilson-worker-env` writes the worker's environment to `/run/wilson-worker.env`,
readable by root only. It reads from the VM's metadata and Secret Manager, as the VM's own service
account, so nothing is copied to a VM by hand and no key is stored in the image.

| Name                           | Kind              | Required | What it is                                                                         |
| ------------------------------ | ----------------- | -------- | ---------------------------------------------------------------------------------- |
| `wilson-url`                   | instance metadata | yes      | Wilson's address, set as `WILSON_URL`                                              |
| `wilson-worker-token-<vm>`     | secret            | yes      | That VM's token, from `wilson host token <vm>`                                     |
| `wilson-claude-token`          | secret            | no       | `CLAUDE_CODE_OAUTH_TOKEN`, used when Wilson assigns the host no engine token       |
| `wilson-github-packages-token` | secret            | no       | `GITHUB_TOKEN`, for a project's own installs, when a host names it in `commandEnv` |
| `wilson-tailscale-key`         | secret            | no       | Joins the tailnet at boot                                                          |

The VM's name picks its token, so a Wilson host and its VM must share a name. A missing required
value leaves the service retrying every 30 seconds, which is what lets a token be added after the VM
is up. `journalctl -u wilson-worker` says which one is missing.

## Idle shutdown

`wilson-idle-shutdown` powers a VM off after an hour with no running engine, no transcript written,
no terminal in use, and a load under 0.5. Its disk stays, with every clone on it. Nothing starts it
again yet, and starting one is an operator's job until Wilson can do that itself.

## Not yet

Nothing boots this image until `infra/vms` is applied.
