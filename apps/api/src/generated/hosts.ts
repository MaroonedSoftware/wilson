import { z } from 'zod';
import { DateTime } from 'luxon';

const _ZodDatetime = z.preprocess(
    val => (typeof val === 'string' ? DateTime.fromISO(val) : val),
    z.custom<DateTime>(val => val instanceof DateTime && val.isValid, { message: 'Must be in ISO 8601 format' }),
);

/**
 * Where one project lives on a host. `codeRoot` is a clone of the project's repo on that machine;
 * a card's worktree is cut from it under `worktreeRoot`, and its plan is written under `runRoot`.
 * generated from [HostProject](../../data/contracts/hosts.ck)
 */
export const HostProject = z.strictObject({
    project: z.string(),
    codeRoot: z.string(),
    worktreeRoot: z.string(),
    runRoot: z.string(),
});
export type HostProject = z.infer<typeof HostProject>;

/**
 * What the last probe of a host found. Describes the machine as it was at `probedAt`, not as it is:
 * a VM deleted after a good probe still reads `ok` until the next one.
 * generated from [HostProbe](../../data/contracts/hosts.ck)
 */
export const HostProbe = z.strictObject({
    probedAt: _ZodDatetime,
    ok: z.preprocess(v => (v === 'true' ? true : v === 'false' ? false : v), z.boolean()),
    detail: z.string().optional().describe('Why it failed, or a short summary of what passed.'),
    engineVersion: z.string().optional().describe('`claude --version` on the host.'),
    expiresAt: _ZodDatetime.optional().describe('When the host will stop by itself, when it said so. Absent is "not reported", not "never".'),
});
export type HostProbe = z.infer<typeof HostProbe>;

/**
 * A slot on a host held by a running stage: which card, of which project, since when. Read from the
 * slot's `wilson.leases` row, so a slot a killed daemon left behind shows here until something takes
 * it back (placement does, the next time it needs one).
 * generated from [HostSlotUse](../../data/contracts/hosts.ck)
 */
export const HostSlotUse = z.strictObject({
    slot: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()),
    project: z.string(),
    cardId: z.string(),
    since: _ZodDatetime,
});
export type HostSlotUse = z.infer<typeof HostSlotUse>;

/**
 * What is shown of a worker host's token: its last four characters and when it was minted, never the
 * token itself.
 * generated from [WorkerTokenSummary](../../data/contracts/hosts.ck)
 */
export const WorkerTokenSummary = z.strictObject({
    hint: z.string(),
    issuedAt: _ZodDatetime,
});
export type WorkerTokenSummary = z.infer<typeof WorkerTokenSummary>;

/**
 * `kind` defaults to `ssh`. For an `ssh` host, `sshTarget` defaults to `name`, which is what an agent
 * VM's `Host agent-*` SSH config entry expects; a `worker` host takes none. `slots` defaults to 1.
 * generated from [CreateHostRequest](../../data/contracts/hosts.ck)
 */
export const CreateHostRequest = z.strictObject({
    name: z.string(),
    kind: z
        .enum(['ssh', 'worker'])
        .optional()
        .describe(
            "`ssh`: the daemon connects out with `ssh`, so it needs a route to the machine, a key for it and\nan ssh client, which Wilson's container images do not have. `worker`: the worker program\n(`apps/worker`) on the machine connects in to the daemon, so the daemon needs no route or key.\nFixed at registration.",
        ),
    sshTarget: z.string().optional().describe('Only for an `ssh` host.'),
    slots: z
        .preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int())
        .optional()
        .describe('How many stages can run there at once, 1 to 8.'),
    lifetimeMinutes: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()).optional(),
    commandEnv: z.array(z.string()).optional(),
    projectsRoot: z
        .string()
        .optional()
        .describe(
            'A folder on the host. A worker clones any project with a GitHub repository under it, so such a\nproject needs no host project of its own. An `ssh` host clones nothing, so each project needs\na clone already on the machine.',
        ),
});
export type CreateHostRequest = z.infer<typeof CreateHostRequest>;

/**
 * A partial update, as `UpdateProjectRequest` is: a field present is set, a field absent is left.
 * No `name`: it is the key every lease and job that names this host will carry. No `kind` either:
 * moving a machine to the other kind is removing the host and registering it again.
 * No `sshTarget`: where a host is reached decides who receives a card's repository, so it has an
 * operation of its own (`PUT /api/hosts/{name}/ssh-target`), behind step-up and out of an agent's reach.
 * generated from [UpdateHostRequest](../../data/contracts/hosts.ck)
 */
export const UpdateHostRequest = z.strictObject({
    slots: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()).optional(),
    enabled: z.preprocess(v => (v === 'true' ? true : v === 'false' ? false : v), z.boolean()).optional(),
    draining: z.preprocess(v => (v === 'true' ? true : v === 'false' ? false : v), z.boolean()).optional(),
    lifetimeMinutes: z
        .preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int())
        .optional()
        .describe('0 clears it: the host has no known end.'),
    commandEnv: z.array(z.string()).optional().describe('Replaces the whole list; an empty list clears it.'),
    projectsRoot: z.string().optional().describe('An empty string clears it.'),
});
export type UpdateHostRequest = z.infer<typeof UpdateHostRequest>;

/**
 * generated from [PutHostSshTargetRequest](../../data/contracts/hosts.ck)
 */
export const PutHostSshTargetRequest = z.strictObject({
    sshTarget: z.string().describe('What `ssh` connects to.'),
});
export type PutHostSshTargetRequest = z.infer<typeof PutHostSshTargetRequest>;

/**
 * generated from [PutHostEngineTokenRequest](../../data/contracts/hosts.ck)
 */
export const PutHostEngineTokenRequest = z.strictObject({
    name: z.string().describe('The name a token was saved under (`/api/engine-tokens/{name}`).'),
});
export type PutHostEngineTokenRequest = z.infer<typeof PutHostEngineTokenRequest>;

/**
 * The three paths for one project on one host. All three are absolute paths on the host.
 * generated from [PutHostProjectRequest](../../data/contracts/hosts.ck)
 */
export const PutHostProjectRequest = z.strictObject({
    codeRoot: z.string(),
    worktreeRoot: z.string(),
    runRoot: z.string(),
});
export type PutHostProjectRequest = z.infer<typeof PutHostProjectRequest>;

/**
 * One registered host. `enabled: false` takes no new stage and is not probed; `draining: true`
 * takes no new stage but lets the ones already there finish.
 * generated from [Host](../../data/contracts/hosts.ck)
 */
export const Host = z.strictObject({
    name: z.string(),
    kind: z
        .enum(['ssh', 'worker'])
        .describe(
            'How the daemon reaches it: `ssh` connects out to `sshTarget`; `worker` waits for the worker\nprogram there to connect in. Fixed at registration.',
        ),
    sshTarget: z.string().optional().describe('Set exactly when `kind` is `ssh`.'),
    slots: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()),
    enabled: z.preprocess(v => (v === 'true' ? true : v === 'false' ? false : v), z.boolean()),
    draining: z.preprocess(v => (v === 'true' ? true : v === 'false' ? false : v), z.boolean()),
    lifetimeMinutes: z
        .preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int())
        .optional()
        .describe(
            "Minutes the host runs after it boots before it stops by itself (720 for an agent VM). The probe\nadds it to the host's boot time to report `probe.expiresAt`. Absent is a host with no known end.",
        ),
    commandEnv: z
        .array(z.string())
        .describe(
            "Variables the host's own environment supplies to the commands stage config runs there (setup,\nbuild, test, format), e.g. GITHUB_TOKEN on an agent VM. Never given to the agent's tools.",
        ),
    projectsRoot: z
        .string()
        .optional()
        .describe(
            'A folder on the host any project with a GitHub repository can live under. A stage for a project\nnot in `projects` adds itself there. Absent, the host serves only what is in `projects`.',
        ),
    projects: z.array(HostProject),
    running: z.array(HostSlotUse).describe('The slots in use right now, slot order. `slots` minus this many are free.'),
    probe: HostProbe.optional(),
    workerToken: WorkerTokenSummary.optional().describe("A worker host's current token, absent until one is minted. Never present on an `ssh` host."),
    engineToken: z
        .string()
        .optional()
        .describe(
            "The name of the saved engine token its engines sign in with, never the token. Absent, a worker's\nengines sign in as that machine was set up to. Never present on an `ssh` host.",
        ),
});
export type Host = z.infer<typeof Host>;

/**
 * A freshly minted worker token. `token` is in this response and nowhere else: only its hash is kept.
 * generated from [IssuedWorkerToken](../../data/contracts/hosts.ck)
 */
export const IssuedWorkerToken = z.strictObject({
    token: z.string(),
    host: Host,
});
export type IssuedWorkerToken = z.infer<typeof IssuedWorkerToken>;
