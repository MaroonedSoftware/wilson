options {
    services: {
        HostsService: "#modules/host/hosts.service.js"
        HostProber: "#modules/host/host.prober.js"
    }
    security: none
}

# The registry of machines other than the daemon's own that a card stage can run on, reached over
# SSH (`runner.hosts`, `runner.host_projects`). Deployment-scoped like `projects.ck`, not per
# project, and in a file of its own for the same reason that one is.
#
# `security: none`, for the reason every other contract here gives: the API binds to 127.0.0.1 and
# has no auth boundary yet (card 0019). The paths below are paths on the host, not on the daemon's
# machine, but they are returned for the same reason `projects.ck` withholds its own: an operator
# managing a host needs to see where its clone is, and a switcher never did.

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
# slot's `runner.leases` row, so a slot a killed daemon left behind shows here until something takes
# it back (placement does, the next time it needs one).
contract HostSlotUse: {
    slot: int
    project: string
    cardId: string
    since: datetime
}

# One registered host. `enabled: false` takes no new stage and is not probed; `draining: true`
# takes no new stage but lets the ones already there finish.
contract Host: {
    name: string
    sshTarget: string
    slots: int
    enabled: boolean
    draining: boolean
    # Minutes the host runs after it boots before it stops by itself (720 for an agent VM). The probe
    # adds it to the host's boot time to report `probe.expiresAt`. Absent is a host with no known end.
    lifetimeMinutes?: int
    # Variables the host's own environment supplies to the commands stage config runs there (setup,
    # build, test, format), e.g. GITHUB_TOKEN on an agent VM. Never given to the agent's tools.
    commandEnv: array(string)
    projects: array(HostProject)
    # The slots in use right now, slot order. `slots` minus this many are free.
    running: array(HostSlotUse)
    probe?: HostProbe
}

# `sshTarget` defaults to `name`, which is what an agent VM's `Host agent-*` SSH config entry
# expects. `slots` defaults to 1.
contract CreateHostRequest: {
    name: string
    sshTarget?: string
    slots?: int
    lifetimeMinutes?: int
    commandEnv?: array(string)
}

# A partial update, as `UpdateProjectRequest` is: a field present is set, a field absent is left.
# No `name`: it is the key every lease and job that names this host will carry.
contract UpdateHostRequest: {
    sshTarget?: string
    slots?: int
    enabled?: boolean
    draining?: boolean
    # 0 clears it: the host has no known end.
    lifetimeMinutes?: int
    # Replaces the whole list; an empty list clears it.
    commandEnv?: array(string)
}

# The three paths for one project on one host. All three are absolute paths on the host.
contract PutHostProjectRequest: {
    codeRoot: string
    worktreeRoot: string
    runRoot: string
}

operation /api/hosts: {
    get: {
        name: List hosts
        service: HostsService.list
        response: {
            200: {
                application/json: array(Host)
            }
        }
    }
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
            # An empty name or SSH target, or slots outside 1 to 8.
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
            # An empty SSH target, or slots outside 1 to 8.
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

# Connect to the host and record what is there: that SSH reaches it, which `claude` it has, that each
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
    delete: {
        name: Remove host project
        service: HostsService.removeProject
        response: {
            204:
            404:
        }
    }
}
