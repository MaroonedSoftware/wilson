import { z } from 'zod';
import { DateTime } from 'luxon';

const _ZodDatetime = z.preprocess(
    val => (typeof val === 'string' ? DateTime.fromISO(val) : val),
    z.custom<DateTime>(val => val instanceof DateTime && val.isValid, { message: 'Must be in ISO 8601 format' }),
);

/**
 * Where one project lives on a host. `codeRoot` is a clone of the project's repo on that machine;
 * a card's worktree is cut from it under `worktreeRoot`, and its plan is written under `runRoot`.
 * generated from [HostProject](file://./../../data/contracts/hosts.ck#L20)
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
 * generated from [HostProbe](file://./../../data/contracts/hosts.ck#L29)
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
 * `sshTarget` defaults to `name`, which is what an agent VM's `Host agent-*` SSH config entry
 * expects. `slots` defaults to 1.
 * generated from [CreateHostRequest](file://./../../data/contracts/hosts.ck#L57)
 */
export const CreateHostRequest = z.strictObject({
    name: z.string(),
    sshTarget: z.string().optional(),
    slots: z.coerce.number().int().optional(),
    lifetimeMinutes: z.coerce.number().int().optional(),
});
export type CreateHostRequest = z.infer<typeof CreateHostRequest>;

/**
 * A partial update, as `UpdateProjectRequest` is: a field present is set, a field absent is left.
 * No `name`: it is the key every lease and job that names this host will carry.
 * generated from [UpdateHostRequest](file://./../../data/contracts/hosts.ck#L66)
 */
export const UpdateHostRequest = z.strictObject({
    sshTarget: z.string().optional(),
    slots: z.coerce.number().int().optional(),
    enabled: z.preprocess(v => (v === 'true' ? true : v === 'false' ? false : v), z.boolean()).optional(),
    draining: z.preprocess(v => (v === 'true' ? true : v === 'false' ? false : v), z.boolean()).optional(),
    lifetimeMinutes: z.coerce.number().int().optional().describe('0 clears it: the host has no known end.'),
});
export type UpdateHostRequest = z.infer<typeof UpdateHostRequest>;

/**
 * The three paths for one project on one host. All three are absolute paths on the host.
 * generated from [PutHostProjectRequest](file://./../../data/contracts/hosts.ck#L76)
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
 * generated from [Host](file://./../../data/contracts/hosts.ck#L42)
 */
export const Host = z.strictObject({
    name: z.string(),
    sshTarget: z.string(),
    slots: z.coerce.number().int(),
    enabled: z.preprocess(v => (v === 'true' ? true : v === 'false' ? false : v), z.boolean()),
    draining: z.preprocess(v => (v === 'true' ? true : v === 'false' ? false : v), z.boolean()),
    lifetimeMinutes: z.coerce
        .number()
        .int()
        .optional()
        .describe(
            "Minutes the host runs after it boots before it stops by itself (720 for an agent VM). The probe\nadds it to the host's boot time to report `probe.expiresAt`. Absent is a host with no known end.",
        ),
    projects: z.array(HostProject),
    probe: HostProbe.optional(),
});
export type Host = z.infer<typeof Host>;
