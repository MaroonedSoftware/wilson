/**
 * Where one project lives on a host. `codeRoot` is a clone of the project's repo on that machine;
 * a card's worktree is cut from it under `worktreeRoot`, and its plan is written under `runRoot`.
 * generated from [HostProject](file://./../../../../apps/api/data/contracts/hosts.ck#L20)
 */
export interface HostProject {
    project: string;
    codeRoot: string;
    worktreeRoot: string;
    runRoot: string;
}

/**
 * What the last probe of a host found. Describes the machine as it was at `probedAt`, not as it is:
 * a VM deleted after a good probe still reads `ok` until the next one.
 * generated from [HostProbe](file://./../../../../apps/api/data/contracts/hosts.ck#L29)
 */
export interface HostProbe {
    probedAt: string;
    ok: boolean;
    /** Why it failed, or a short summary of what passed. */
    detail?: string;
    /** `claude --version` on the host. */
    engineVersion?: string;
    /** When the host will stop by itself, when it said so. Absent is "not reported", not "never". */
    expiresAt?: string;
}

/**
 * A slot on a host held by a running stage: which card, of which project, since when. Read from the
 * slot's `runner.leases` row, so a slot a killed daemon left behind shows here until something takes
 * it back (placement does, the next time it needs one).
 * generated from [HostSlotUse](file://./../../../../apps/api/data/contracts/hosts.ck#L43)
 */
export interface HostSlotUse {
    slot: number;
    project: string;
    cardId: string;
    since: string;
}

/**
 * `sshTarget` defaults to `name`, which is what an agent VM's `Host agent-*` SSH config entry
 * expects. `slots` defaults to 1.
 * generated from [CreateHostRequest](file://./../../../../apps/api/data/contracts/hosts.ck#L69)
 */
export interface CreateHostRequest {
    name: string;
    sshTarget?: string;
    slots?: number;
    lifetimeMinutes?: number;
}

/**
 * A partial update, as `UpdateProjectRequest` is: a field present is set, a field absent is left.
 * No `name`: it is the key every lease and job that names this host will carry.
 * generated from [UpdateHostRequest](file://./../../../../apps/api/data/contracts/hosts.ck#L78)
 */
export interface UpdateHostRequest {
    sshTarget?: string;
    slots?: number;
    enabled?: boolean;
    draining?: boolean;
    /** 0 clears it: the host has no known end. */
    lifetimeMinutes?: number;
}

/**
 * The three paths for one project on one host. All three are absolute paths on the host.
 * generated from [PutHostProjectRequest](file://./../../../../apps/api/data/contracts/hosts.ck#L88)
 */
export interface PutHostProjectRequest {
    codeRoot: string;
    worktreeRoot: string;
    runRoot: string;
}

/**
 * One registered host. `enabled: false` takes no new stage and is not probed; `draining: true`
 * takes no new stage but lets the ones already there finish.
 * generated from [Host](file://./../../../../apps/api/data/contracts/hosts.ck#L52)
 */
export interface Host {
    name: string;
    sshTarget: string;
    slots: number;
    enabled: boolean;
    draining: boolean;
    /**
     * Minutes the host runs after it boots before it stops by itself (720 for an agent VM). The probe
     * adds it to the host's boot time to report `probe.expiresAt`. Absent is a host with no known end.
     */
    lifetimeMinutes?: number;
    projects: HostProject[];
    /** The slots in use right now, slot order. `slots` minus this many are free. */
    running: HostSlotUse[];
    probe?: HostProbe;
}
