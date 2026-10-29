import { z } from 'zod';
import { DateTime } from 'luxon';

const _ZodDatetime = z.preprocess(
    val => (typeof val === 'string' ? DateTime.fromISO(val) : val),
    z.custom<DateTime>(val => val instanceof DateTime && val.isValid, { message: 'Must be in ISO 8601 format' }),
);

/**
 * One stored document. `yaml` is the text verbatim, comments included — the document is the config,
 * not a rendering of columns. `message` is what the commit message on `stages.yaml` used to be.
 * generated from [StageConfigDocument](../../data/contracts/stages.ck)
 */
export const StageConfigDocument = z.strictObject({
    id: z.string(),
    yaml: z.string(),
    message: z.string(),
    createdAt: _ZodDatetime,
});
export type StageConfigDocument = z.infer<typeof StageConfigDocument>;

/**
 * `message` optional: `wilson stages edit` has no commit-message prompt the way `git commit` does,
 * and a default ("Edited stage config") beats forcing one. Supply it when the change is worth a
 * sentence — "Raise the review step budget to 150" is what the history is for.
 * generated from [SetStageConfigRequest](../../data/contracts/stages.ck)
 */
export const SetStageConfigRequest = z.strictObject({
    yaml: z.string(),
    message: z.string().optional(),
});
export type SetStageConfigRequest = z.infer<typeof SetStageConfigRequest>;

/**
 * generated from [StageConfigVersion](../../data/contracts/stages.ck)
 */
export const StageConfigVersion = z.strictObject({
    id: z.string(),
    message: z.string(),
    createdAt: _ZodDatetime,
});
export type StageConfigVersion = z.infer<typeof StageConfigVersion>;

/**
 * Same shape as board.ck's `ListQuery`, declared here rather than shared: a contract file is the
 * unit contractkit generates from, and a cross-file reference is not worth a coupling for one
 * optional field.
 * generated from [StageConfigVersionsQuery](../../data/contracts/stages.ck)
 */
export const StageConfigVersionsQuery = z.strictObject({
    limit: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()).optional(),
});
export type StageConfigVersionsQuery = z.infer<typeof StageConfigVersionsQuery>;
