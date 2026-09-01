import { z } from 'zod';
import { DateTime } from 'luxon';

const _ZodDatetime = z.preprocess(
    val => (typeof val === 'string' ? DateTime.fromISO(val) : val),
    z.custom<DateTime>(val => val instanceof DateTime && val.isValid, { message: 'Must be in ISO 8601 format' }),
);

/**
 * One stored document. `yaml` is the text verbatim, comments included — the document is the config,
 * not a rendering of columns. `message` is what the commit message on `stages.yaml` used to be.
 * generated from [StageConfigDocument](file://./../../data/contracts/stages.ck#L26)
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
 * generated from [SetStageConfigRequest](file://./../../data/contracts/stages.ck#L36)
 */
export const SetStageConfigRequest = z.strictObject({
    yaml: z.string(),
    message: z.string().optional(),
});
export type SetStageConfigRequest = z.infer<typeof SetStageConfigRequest>;

/**
 * generated from [StageConfigVersion](file://./../../data/contracts/stages.ck#L41)
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
 * generated from [StageConfigVersionsQuery](file://./../../data/contracts/stages.ck#L50)
 */
export const StageConfigVersionsQuery = z.strictObject({
    limit: z.coerce.number().int().optional(),
});
export type StageConfigVersionsQuery = z.infer<typeof StageConfigVersionsQuery>;
