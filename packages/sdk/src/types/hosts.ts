import { DateTime } from 'luxon';
const __dt = (v: unknown, path: string): DateTime => {
    if (typeof v !== 'string') {
        throw new TypeError(`ContractKit: expected an ISO 8601 string at '${path}', received ${typeof v}.`);
    }
    const d = DateTime.fromISO(v);
    if (!d.isValid) throw new TypeError(`ContractKit: '${v}' at '${path}' is not a valid ISO 8601 datetime.`);
    return d;
};

/**
 * Where one project lives on a host. `codeRoot` is a clone of the project's repo on that machine;
 * a card's worktree is cut from it under `worktreeRoot`, and its plan is written under `runRoot`.
 * generated from [HostProject](../../../../apps/api/data/contracts/hosts.ck)
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
 * generated from [HostProbe](../../../../apps/api/data/contracts/hosts.ck)
 */
export interface HostProbe {
    probedAt: DateTime;
    ok: boolean;
    /** Why it failed, or a short summary of what passed. */
    detail?: string;
    /** `claude --version` on the host. */
    engineVersion?: string;
    /** When the host will stop by itself, when it said so. Absent is "not reported", not "never". */
    expiresAt?: DateTime;
}

/** Rehydrates every wire-encoded scalar in a HostProbe into its runtime type. Mutates and returns `raw`. */
export function reviveHostProbe(raw: HostProbe): HostProbe {
    const __o0 = raw as unknown as Record<string, unknown>;
    __o0['probedAt'] = __dt(__o0['probedAt'], 'HostProbe.probedAt');
    if (__o0['expiresAt'] != null) {
        __o0['expiresAt'] = __dt(__o0['expiresAt'], 'HostProbe.expiresAt');
    }
    return raw;
}

/**
 * A slot on a host held by a running stage: which card, of which project, since when. Read from the
 * slot's `runner.leases` row, so a slot a killed daemon left behind shows here until something takes
 * it back (placement does, the next time it needs one).
 * generated from [HostSlotUse](../../../../apps/api/data/contracts/hosts.ck)
 */
export interface HostSlotUse {
    slot: number;
    project: string;
    cardId: string;
    since: DateTime;
}

/** Rehydrates every wire-encoded scalar in a HostSlotUse into its runtime type. Mutates and returns `raw`. */
export function reviveHostSlotUse(raw: HostSlotUse): HostSlotUse {
    const __o0 = raw as unknown as Record<string, unknown>;
    __o0['since'] = __dt(__o0['since'], 'HostSlotUse.since');
    return raw;
}

/**
 * What is shown of a worker host's token: its last four characters and when it was minted, never the
 * token itself.
 * generated from [WorkerTokenSummary](../../../../apps/api/data/contracts/hosts.ck)
 */
export interface WorkerTokenSummary {
    hint: string;
    issuedAt: DateTime;
}

/** Rehydrates every wire-encoded scalar in a WorkerTokenSummary into its runtime type. Mutates and returns `raw`. */
export function reviveWorkerTokenSummary(raw: WorkerTokenSummary): WorkerTokenSummary {
    const __o0 = raw as unknown as Record<string, unknown>;
    __o0['issuedAt'] = __dt(__o0['issuedAt'], 'WorkerTokenSummary.issuedAt');
    return raw;
}

/**
 * `kind` defaults to `ssh`. For an `ssh` host, `sshTarget` defaults to `name`, which is what an agent
 * VM's `Host agent-*` SSH config entry expects; a `worker` host takes none. `slots` defaults to 1.
 * generated from [CreateHostRequest](../../../../apps/api/data/contracts/hosts.ck)
 */
export interface CreateHostRequest {
    name: string;
    kind?: 'ssh' | 'worker';
    sshTarget?: string;
    slots?: number;
    lifetimeMinutes?: number;
    commandEnv?: string[];
}

/**
 * A partial update, as `UpdateProjectRequest` is: a field present is set, a field absent is left.
 * No `name`: it is the key every lease and job that names this host will carry. No `kind` either:
 * moving a machine to the other kind is removing the host and registering it again.
 * generated from [UpdateHostRequest](../../../../apps/api/data/contracts/hosts.ck)
 */
export interface UpdateHostRequest {
    /** Only for an `ssh` host. */
    sshTarget?: string;
    slots?: number;
    enabled?: boolean;
    draining?: boolean;
    /** 0 clears it: the host has no known end. */
    lifetimeMinutes?: number;
    /** Replaces the whole list; an empty list clears it. */
    commandEnv?: string[];
}

/**
 * The three paths for one project on one host. All three are absolute paths on the host.
 * generated from [PutHostProjectRequest](../../../../apps/api/data/contracts/hosts.ck)
 */
export interface PutHostProjectRequest {
    codeRoot: string;
    worktreeRoot: string;
    runRoot: string;
}

/**
 * One registered host. `enabled: false` takes no new stage and is not probed; `draining: true`
 * takes no new stage but lets the ones already there finish.
 * generated from [Host](../../../../apps/api/data/contracts/hosts.ck)
 */
export interface Host {
    name: string;
    /**
     * How the daemon reaches it: `ssh` connects out to `sshTarget`; `worker` waits for the worker
     * program there to connect in. Fixed at registration.
     */
    kind: 'ssh' | 'worker';
    /** Set exactly when `kind` is `ssh`. */
    sshTarget?: string;
    slots: number;
    enabled: boolean;
    draining: boolean;
    /**
     * Minutes the host runs after it boots before it stops by itself (720 for an agent VM). The probe
     * adds it to the host's boot time to report `probe.expiresAt`. Absent is a host with no known end.
     */
    lifetimeMinutes?: number;
    /**
     * Variables the host's own environment supplies to the commands stage config runs there (setup,
     * build, test, format), e.g. GITHUB_TOKEN on an agent VM. Never given to the agent's tools.
     */
    commandEnv: string[];
    projects: HostProject[];
    /** The slots in use right now, slot order. `slots` minus this many are free. */
    running: HostSlotUse[];
    probe?: HostProbe;
    /** A worker host's current token, absent until one is minted. Never present on an `ssh` host. */
    workerToken?: WorkerTokenSummary;
}

/** Rehydrates every wire-encoded scalar in a Host into its runtime type. Mutates and returns `raw`. */
export function reviveHost(raw: Host): Host {
    const __o0 = raw as unknown as Record<string, unknown>;
    {
        const __a1 = __o0['running'] as unknown[];
        for (let __i2 = 0; __i2 < __a1.length; __i2++) {
            reviveHostSlotUse(__a1[__i2] as never);
        }
    }
    if (__o0['probe'] != null) {
        reviveHostProbe(__o0['probe'] as never);
    }
    if (__o0['workerToken'] != null) {
        reviveWorkerTokenSummary(__o0['workerToken'] as never);
    }
    return raw;
}

/**
 * A freshly minted worker token. `token` is in this response and nowhere else: only its hash is kept.
 * generated from [IssuedWorkerToken](../../../../apps/api/data/contracts/hosts.ck)
 */
export interface IssuedWorkerToken {
    token: string;
    host: Host;
}

/** Rehydrates every wire-encoded scalar in a IssuedWorkerToken into its runtime type. Mutates and returns `raw`. */
export function reviveIssuedWorkerToken(raw: IssuedWorkerToken): IssuedWorkerToken {
    const __o0 = raw as unknown as Record<string, unknown>;
    reviveHost(__o0['host'] as never);
    return raw;
}
