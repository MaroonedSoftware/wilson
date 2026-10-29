/**
 * Where one project lives on a host. `codeRoot` is a clone of the project's repo on that machine;
 * a card's worktree is cut from it under `worktreeRoot`, and its plan is written under `runRoot`.
 * generated from [HostProject](file://./../../../../apps/api/data/contracts/hosts.ck#L19)
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
 * generated from [HostProbe](file://./../../../../apps/api/data/contracts/hosts.ck#L28)
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
 * `sshTarget` defaults to `name`, which is what an agent VM's `Host agent-*` SSH config entry
 * expects. `slots` defaults to 1.
 * generated from [CreateHostRequest](file://./../../../../apps/api/data/contracts/hosts.ck#L53)
 */
export interface CreateHostRequest {
    name: string;
    sshTarget?: string;
    slots?: number;
}

/**
 * A partial update, as `UpdateProjectRequest` is: a field present is set, a field absent is left.
 * No `name`: it is the key every lease and job that names this host will carry.
 * generated from [UpdateHostRequest](file://./../../../../apps/api/data/contracts/hosts.ck#L61)
 */
export interface UpdateHostRequest {
    sshTarget?: string;
    slots?: number;
    enabled?: boolean;
    draining?: boolean;
}

/**
 * The three paths for one project on one host. All three are absolute paths on the host.
 * generated from [PutHostProjectRequest](file://./../../../../apps/api/data/contracts/hosts.ck#L69)
 */
export interface PutHostProjectRequest {
    codeRoot: string;
    worktreeRoot: string;
    runRoot: string;
}

/**
 * One registered host. `enabled: false` takes no new stage and is not probed; `draining: true`
 * takes no new stage but lets the ones already there finish.
 * generated from [Host](file://./../../../../apps/api/data/contracts/hosts.ck#L41)
 */
export interface Host {
    name: string;
    sshTarget: string;
    slots: number;
    enabled: boolean;
    draining: boolean;
    projects: HostProject[];
    probe?: HostProbe;
}
