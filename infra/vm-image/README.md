# `infra/vm-image`: the Wilson VM image

The Compute Engine image a Wilson VM boots from, built with Packer. It is published to the `wilson`
image family, so whatever creates a VM asks for the family and gets the newest build.

It holds no project. A project's clone and its dependencies live on the VM's own disk, so one image
serves every project, and what a project needs beyond the list below it installs in its own setup
command.

| What                    | Where                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| Ubuntu 24.04            | `ubuntu-2404-lts-amd64`                                                                   |
| Node 22, Corepack       | The system's Node, which the engine runs on. Corepack gives a project its yarn or pnpm    |
| mise                    | `/opt/mise`, with Node 20 and 24, Python 3.13 and Go. Reads `.tool-versions`, `mise.toml` and `.nvmrc` |
| Docker and Compose      | `docker.io`, `docker-compose-v2`                                                          |
| git, psql, tmux, jq     |                                                                                           |
| Claude Code             | Pinned to `CLAUDE_BINARY_VERSION`, with its updater off                                   |
| Ops Agent               | Logs and metrics in Cloud Logging and Monitoring                                          |

`gh` and GitHub credentials are left out on purpose: Wilson moves commits itself and never pushes to a
forge, so a stage has no need of them.

## Building

From a laptop, with Packer and `gcloud` installed and signed in:

```bash
brew install hashicorp/tap/packer
gcloud auth application-default login
infra/vm-image/build.sh
```

The build uses TGA's `infra/agents` network and account, so it needs the same access as an agent user
plus rights to create instances and images in `toku-agents`. It counts as one more VM against that
project's quotas while it runs. It takes no token, since it clones nothing private.

`build.sh` reads the engine version from `apps/api/src/modules/agent/cli.engine.version.ts`. After
bumping `CLAUDE_BINARY_VERSION`, build a new image. `provision.sh` fails the build if the installed
version differs, or if a basic check of the toolchain does not pass.

## Not yet

Nothing boots this image yet. The worker, its service and the idle shutdown come next, then the
instance template in TGA's `infra/agents`.
