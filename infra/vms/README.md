# `infra/vms`: the VMs Wilson runs stages on

`wilson-1` to `wilson-6`, each running the worker at boot from the image `infra/vm-image` builds. Each
is one Wilson host, and any project with a GitHub repository can run on it.

They run in `toku-agents`, in the network TGA's `infra/agents` owns. This root looks that network up
and changes nothing of TGA's: its state is its own, under the `wilson-vms` prefix of the project's
state bucket, and nothing in TGA's repository refers to it.

| Resource                     | Why                                                                        |
| ---------------------------- | -------------------------------------------------------------------------- |
| `wilson-*` instance template | What a VM is: `e2-highmem-4`, 75 GB, no public address, the `wilson` image |
| `wilson-vm` service account  | Reads the secrets below, writes logs and metrics, holds nothing else       |
| Secret Manager secrets       | Empty. Values are added by hand, so they never reach Terraform state       |

## Who can reach a VM

Only `wilson_operators`. TGA's agent users have sudo through OS Login on every VM in the project, but
OS Login refuses a VM whose account you cannot act as, and only `wilson_operators` can act as
`wilson-vm`. An agent session cannot read the secrets, since it runs as `agent-vm`, which has no role
here. Project owners can still reach everything.

## Lifetime

No time limit, unlike an agent VM: each keeps its clones and dependencies, which saves a project's
cold install on every stage. The image powers one off after an idle hour, keeping its disk, and
nothing starts it again except `up`. A stopped 75 GB disk costs about $7.50 a month until `down`.

## Reaching Wilson

Wilson is not in Google Cloud, so a VM joins a tailnet at boot, using `wilson-tailscale-key`, and
connects out. Limit that key's tag by ACL to the one port Wilson listens on. `wilson_url` is Wilson's
address on the tailnet.

## How many at once

Six of these, six 50 GB agent VMs and an image build come to 780 GB of the region's 800 GB SSD quota.
Together the twelve VMs fill the 48 vCPU quota, so running these means running that many fewer agent
VMs.

## Bringing it up

Before the first apply, have someone who runs `toku-agents` agree to what this adds to it: no time
limit on these VMs, a route out over Tailscale, and Secret Manager.

Sign in with `gcloud auth application-default login`, then, from the repository root:

```bash
terraform -chdir=infra/vms init
terraform -chdir=infra/vms apply
```

Add the shared secrets' values once. Each command reads the value from standard input, so paste it and
press Ctrl-D:

```bash
for name in wilson-claude-token wilson-tailscale-key wilson-github-packages-token; do
  gcloud secrets versions add "$name" --project=toku-agents --data-file=-
done
```

Then, for each VM, register it in Wilson under the same name, store its token, and start it:

```bash
wilson host add wilson-1 --worker --projects-root /srv/wilson --command-env GITHUB_TOKEN
wilson host token wilson-1
gcloud secrets versions add wilson-worker-token-wilson-1 --project=toku-agents --data-file=-
infra/vms/scripts/wilson_vm.sh up 1
```

`wilson_vm.sh ls` shows the pool, and `down N` deletes a VM and its disk. `journalctl -u wilson-worker`
on a VM says what it is waiting for.
