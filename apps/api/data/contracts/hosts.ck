options {
    services: {
        HostsService: "#modules/host/hosts.service.js"
        HostProber: "#modules/host/host.prober.js"
        WorkerTokensService: "#modules/host/worker.tokens.service.js"
    }
    security: {
        policy: wilson.manage
    }
}

# The registry of machines other than the daemon's own that a card stage can run on, reached over
# SSH or by a worker that connects in (`wilson.hosts`, `wilson.host_projects`). Deployment-scoped like `projects.ck`, not per
# project, and in a file of its own for the same reason that one is.
#
# Gated (PROJECT.md decision 10): the file's floor is `wilson.manage`, which a signed-in session
# or a `manage` API key satisfies, and every `get` lowers it to `wilson.view`, which any session
# or key does. Anything without a credential gets 401 before a handler runs.
#
# The paths below are paths on the host, not on the daemon's machine, and they are returned where
# `projects.ck` withholds its own: an operator managing a host needs to see where its clone is, and a
# switcher never did.

# Where one project lives on a host. `codeRoot` is a clone of the project's repo on that machine;
# a card's worktree is cut from it under `worktreeRoot`, and its plan is written under `runRoot`.
contract HostProject: {
    project: string
    codeRoot: string
    worktreeRoot: string
    runRoot: string
}

# What the last probe of a host found. Describes the machine as it was at `probedAt`, not as it is:
# a VM deleted after a good probe still reads `ok` until the next one.
contract HostProbe: {
    probedAt: datetime
    ok: boolean
    # Why it failed, or a short summary of what passed.
    detail?: string
    # `claude --version` on the host.
    engineVersion?: string
    # When the host will stop by itself, when it said so. Absent is "not reported", not "never".
    expiresAt?: datetime
}

# A slot on a host held by a running stage: which card, of which project, since when. Read from the
# slot's `wilson.leases` row, so a slot a killed daemon left behind shows here until something takes
# it back (placement does, the next time it needs one).
contract HostSlotUse: {
    slot: int
    project: string
    cardId: string
    since: datetime
}

# What is shown of a worker host's token: its last four characters and when it was minted, never the
# token itself.
contract WorkerTokenSummary: {
    hint: string
    issuedAt: datetime
}

# A freshly minted worker token. `token` is in this response and nowhere else: only its hash is kept.
contract IssuedWorkerToken: {
    token: string
    host: Host
}

# One registered host. `enabled: false` takes no new stage and is not probed; `draining: true`
# takes no new stage but lets the ones already there finish.
contract Host: {
    name: string
    # How the daemon reaches it: `ssh` connects out to `sshTarget`; `worker` waits for the worker
    # program there to connect in. Fixed at registration.
    kind: enum(ssh, worker)
    # Set exactly when `kind` is `ssh`.
    sshTarget?: string
    slots: int
    enabled: boolean
    draining: boolean
    # Minutes the host runs after it boots before it stops by itself (720 for an agent VM). The probe
    # adds it to the host's boot time to report `probe.expiresAt`. Absent is a host with no known end.
    lifetimeMinutes?: int
    # Variables the host's own environment supplies to the commands stage config runs there (setup,
    # build, test, format), e.g. GITHUB_TOKEN on an agent VM. Never given to the agent's tools.
    commandEnv: array(string)
    # A folder on the host any project with a GitHub repository can live under. A stage for a project
    # not in `projects` adds itself there. Absent, the host serves only what is in `projects`.
    projectsRoot?: string
    projects: array(HostProject)
    # The slots in use right now, slot order. `slots` minus this many are free.
    running: array(HostSlotUse)
    probe?: HostProbe
    # A worker host's current token, absent until one is minted. Never present on an `ssh` host.
    workerToken?: WorkerTokenSummary
}

# `kind` defaults to `ssh`. For an `ssh` host, `sshTarget` defaults to `name`, which is what an agent
# VM's `Host agent-*` SSH config entry expects; a `worker` host takes none. `slots` defaults to 1.
contract CreateHostRequest: {
    name: string
    # `ssh`: the daemon connects out with `ssh`, so it needs a route to the machine, a key for it and
    # an ssh client, which Wilson's container images do not have. `worker`: the worker program
    # (`apps/worker`) on the machine connects in to the daemon, so the daemon needs no route or key.
    # Fixed at registration.
    kind?: enum(ssh, worker)
    # Only for an `ssh` host.
    sshTarget?: string
    # How many stages can run there at once, 1 to 8.
    slots?: int
    lifetimeMinutes?: int
    commandEnv?: array(string)
    # A folder on the host. A worker clones any project with a GitHub repository under it, so such a
    # project needs no host project of its own. An `ssh` host clones nothing, so each project needs
    # a clone already on the machine.
    projectsRoot?: string
}

# A partial update, as `UpdateProjectRequest` is: a field present is set, a field absent is left.
# No `name`: it is the key every lease and job that names this host will carry. No `kind` either:
# moving a machine to the other kind is removing the host and registering it again.
contract UpdateHostRequest: {
    # Only for an `ssh` host.
    sshTarget?: string
    slots?: int
    enabled?: boolean
    draining?: boolean
    # 0 clears it: the host has no known end.
    lifetimeMinutes?: int
    # Replaces the whole list; an empty list clears it.
    commandEnv?: array(string)
    # An empty string clears it.
    projectsRoot?: string
}

# The three paths for one project on one host. All three are absolute paths on the host.
contract PutHostProjectRequest: {
    codeRoot: string
    worktreeRoot: string
    runRoot: string
}

operation /api/hosts: {
    get: {
        security: {
            policy: wilson.view
        }
        name: List hosts
        service: HostsService.list
        response: {
            200: {
                application/json: array(Host)
            }
        }
    }
    # Register a machine card stages can run on, reached over SSH or by a worker program that connects
    # in. A worker host then needs its token minted with `wilson host token` or on the web app's Hosts
    # page, which agents cannot do, and the worker started on the machine (`apps/worker/README.md`).
    post: {
        name: Register host
        service: HostsService.create
        request: {
            application/json: CreateHostRequest
        }
        response: {
            201: {
                application/json: Host
            }
            # An empty name or SSH target, an SSH target for a worker host, or slots outside 1 to 8.
            400:
            # The name is already registered.
            409:
        }
    }
}

operation /api/hosts/{name}: {
    params: {
        name: string
    }
    get: {
        security: {
            policy: wilson.view
        }
        name: Get host
        service: HostsService.get
        response: {
            200: {
                application/json: Host
            }
            404:
        }
    }
    patch: {
        name: Update host
        service: HostsService.update
        request: {
            application/json: UpdateHostRequest
        }
        response: {
            200: {
                application/json: Host
            }
            # An empty SSH target, an SSH target for a worker host, or slots outside 1 to 8.
            400:
            404:
        }
    }
    delete: {
        name: Remove host
        service: HostsService.remove
        response: {
            204:
            404:
        }
    }
}

# Connect to the host and record what is there: that it can be reached, which `claude` it has, that each
# project's clone is a git repository and its roots can be written, and, given a lifetime, when it
# will stop. A failed check is a recorded result (`probe.ok: false`), not an error response.
operation /api/hosts/{name}/probe: {
    params: {
        name: string
    }
    post: {
        name: Probe host
        service: HostProber.probe
        response: {
            200: {
                application/json: Host
            }
            404:
            # The host is disabled, and a disabled host is not probed.
            409:
        }
    }
}

# `put`, not `patch`: a project on a host is its three paths together, and a half-set one would
# cut worktrees from a clone that is not there.
operation /api/hosts/{name}/projects/{project}: {
    params: {
        name: string
        project: string
    }
    # Say where a project lives on a host, which lets stages for it run there. Not needed for a
    # project a worker host's `projectsRoot` takes on by itself.
    put: {
        name: Set host project
        service: HostsService.putProject
        request: {
            application/json: PutHostProjectRequest
        }
        response: {
            200: {
                application/json: Host
            }
            # A path that is not absolute.
            400:
            # No such host, or no such registered project.
            404:
        }
    }
    # Stop serving a project from a host. Files already on the machine are left there.
    delete: {
        name: Remove host project
        service: HostsService.removeProject
        response: {
            204:
            404:
        }
    }
}

# The one credential a worker host's worker program connects with. Only the worker endpoint accepts
# it, and only as this host, so it grants less than the `manage` key or session minting it already
# holds; that is why minting needs `wilson.manage` and not a step-up, which a CLI key cannot give.
# `post` mints one, replacing any the host had, so rotating is posting again.
operation /api/hosts/{name}/worker-token: {
    params: {
        name: string
    }
    post: {
        name: Mint worker token
        mcp: exclude # Credentials are never handed to an agent
        sdk: mintWorkerToken
        service: WorkerTokensService.issue
        response: {
            201: {
                application/json: IssuedWorkerToken
            }
            # The host is reached over SSH, and has nothing to connect with a token.
            400:
            404:
        }
    }
    delete: {
        name: Revoke worker token
        mcp: exclude # Credentials are never handed to an agent
        sdk: revokeWorkerToken
        service: WorkerTokensService.revoke
        response: {
            204:
            400:
            404:
        }
    }
}
