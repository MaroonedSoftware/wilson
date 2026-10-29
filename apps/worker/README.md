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
  commands use.

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

3. On the worker's machine, get a token for the engine with `claude setup-token`, then start the
   worker from a checkout of this repository:

    ```bash
    WILSON_URL=http://tower:13100 WILSON_WORKER_TOKEN=wilson_worker_... CLAUDE_CODE_OAUTH_TOKEN=... pnpm --filter @wilson/worker start
    ```

4. Back on Wilson, `wilson host probe unraid-vm` should pass. Stages placed `remote` or `any` can now
   land on it.

## Environment

| Variable                  | Required | What it is                                                            |
| ------------------------- | -------- | --------------------------------------------------------------------- |
| `WILSON_URL`              | yes      | Wilson's API, e.g. `http://tower:13100`                               |
| `WILSON_WORKER_TOKEN`     | yes      | This host's token, from `wilson host token <name>`                    |
| `CLAUDE_CODE_OAUTH_TOKEN` | no       | What the engine signs in with. Unset, `claude`'s own sign-in is used. |
| `WILSON_CLAUDE`           | no       | The `claude` binary, when it is not the one on `PATH`                 |

Wilson never sends the engine token. Only this machine's own is used.

## Keeping it running

The worker reconnects by itself, backing off up to 30 seconds, whenever Wilson restarts or the
network drops. Any process a stage started is killed when its connection drops; the stage is retried.

It exits for good, with status 1, when retrying cannot help: Wilson refused the token, speaks another
protocol version, or another worker connected as the same host. A supervisor (systemd, launchd,
Unraid's User Scripts) should restart it on other exits but not that one. With systemd:

```ini
[Service]
Environment=WILSON_URL=http://tower:13100
EnvironmentFile=/etc/wilson-worker.env
WorkingDirectory=/opt/wilson
ExecStart=/usr/bin/pnpm --filter @wilson/worker start
Restart=on-failure
RestartPreventExitStatus=1
```

with `WILSON_WORKER_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` in `/etc/wilson-worker.env`, readable by root
only.
