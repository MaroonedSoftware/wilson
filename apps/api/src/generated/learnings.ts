import { z } from 'zod';
import { DateTime } from 'luxon';

const _ZodDatetime = z.preprocess(
    val => (typeof val === 'string' ? DateTime.fromISO(val) : val),
    z.custom<DateTime>(val => val instanceof DateTime && val.isValid, { message: 'Must be in ISO 8601 format' }),
);

/**
 * A project's human-approved learnings document (card 0239) — the operator's surface, cloned from
 * `stages.ck`'s `StageConfigDocument` shape: `wilson learnings show|edit|set|versions` all call
 * here. Agents never read this document through this API; card 0244 materializes it for a stage
 * agent a different way, and no agent runs with this API reachable as a tool in the first place
 * (PROJECT.md decision 6, decision 8's own reasoning — see `stages.ck`'s comment for the fuller
 * argument, which applies here unchanged).
 *
 * `security: none` for the same reason `stages.ck` is: the API binds to 127.0.0.1 with no auth
 * boundary yet (card 0019).
 *
 * Unlike stage config, a learnings document has no schema to validate — `markdown` is free text, so
 * there is no `400` here, and a project with no document yet is not a failure either: `GET
 * /api/learnings` answers with an empty document rather than a `404`, since an operator retiring
 * every learning at once (an empty save) must read back the same way a project that never saved one
 * does.
 * generated from [LearningsDocument](file://./../../data/contracts/learnings.ck#L23)
 */
export const LearningsDocument = z.strictObject({
    id: z.string().optional(),
    markdown: z.string(),
    message: z.string(),
    createdAt: _ZodDatetime.optional(),
});
export type LearningsDocument = z.infer<typeof LearningsDocument>;

/**
 * `message` optional, same reasoning as `SetStageConfigRequest`: `wilson learnings edit` has no
 * commit-message prompt the way `git commit` does, and a default ("Edited learnings") beats forcing
 * one.
 * generated from [SetLearningsRequest](file://./../../data/contracts/learnings.ck#L33)
 */
export const SetLearningsRequest = z.strictObject({
    markdown: z.string(),
    message: z.string().optional(),
});
export type SetLearningsRequest = z.infer<typeof SetLearningsRequest>;

/**
 * generated from [LearningsVersion](file://./../../data/contracts/learnings.ck#L38)
 */
export const LearningsVersion = z.strictObject({
    id: z.string(),
    message: z.string(),
    createdAt: _ZodDatetime,
});
export type LearningsVersion = z.infer<typeof LearningsVersion>;

/**
 * generated from [LearningsVersionsQuery](file://./../../data/contracts/learnings.ck#L44)
 */
export const LearningsVersionsQuery = z.strictObject({
    limit: z.coerce.number().int().optional(),
});
export type LearningsVersionsQuery = z.infer<typeof LearningsVersionsQuery>;
