import { z } from 'zod';
import { DateTime } from 'luxon';

const _ZodDatetime = z.preprocess(
    val => (typeof val === 'string' ? DateTime.fromISO(val) : val),
    z.custom<DateTime>(val => val instanceof DateTime && val.isValid, { message: 'Must be in ISO 8601 format' }),
);
type _JsonValue = string | number | boolean | null | _JsonValue[] | { [key: string]: _JsonValue };
const _ZodJson: z.ZodType<_JsonValue> = z.lazy(() =>
    z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(_ZodJson), z.record(z.string(), _ZodJson)]),
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

/**
 * Which engine, provider and model a stage runs on, as it would dispatch now. `mode` is here so a
 * client can tell the stages that reach a model from the manual ones that never do, which have no
 * `model`.
 * generated from [StageRouting](../../data/contracts/stages.ck)
 */
export const StageRouting = z.strictObject({
    stage: z.string(),
    mode: z.enum(['agent', 'command', 'manual']),
    adapter: z.enum(['api', 'cli', 'codex']),
    provider: z.enum(['anthropic', 'openai', 'xai']),
    model: z.string().optional(),
});
export type StageRouting = z.infer<typeof StageRouting>;

/**
 * generated from [SetStageRoutingRequest](../../data/contracts/stages.ck)
 */
export const SetStageRoutingRequest = z.strictObject({
    adapter: z.enum(['api', 'cli', 'codex']),
    provider: z.enum(['anthropic', 'openai', 'xai']),
    model: z.string(),
    message: z.string().optional(),
});
export type SetStageRoutingRequest = z.infer<typeof SetStageRoutingRequest>;

/**
 * One lane, as `wilson.lanes` holds it. `settings` is everything else a stage can say (budgets,
 * commands, placement), holding only what someone chose, so a default stays a default.
 * generated from [Lane](../../data/contracts/stages.ck)
 */
export const Lane = z.strictObject({
    name: z.string(),
    position: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()),
    mode: z.enum(['agent', 'command', 'manual']),
    worktree: z.enum(['none', 'readonly', 'rw']),
    onPass: z.string(),
    onFail: z.string(),
    adapter: z.enum(['api', 'cli', 'codex']).optional(),
    provider: z.enum(['anthropic', 'openai', 'xai']).optional(),
    model: z.string().optional(),
    instructions: z.string(),
    settings: _ZodJson,
});
export type Lane = z.infer<typeof Lane>;

/**
 * Only what changes. A key in `settings` is set, or removed when its value is null. Routing has its own
 * operation below, which checks it against what the lane's engine can run.
 * generated from [PatchLaneRequest](../../data/contracts/stages.ck)
 */
export const PatchLaneRequest = z.strictObject({
    mode: z.enum(['agent', 'command', 'manual']).optional(),
    worktree: z.enum(['none', 'readonly', 'rw']).optional(),
    onPass: z.string().optional(),
    onFail: z.string().optional(),
    instructions: z.string().optional(),
    settings: _ZodJson.optional(),
    message: z.string().optional(),
});
export type PatchLaneRequest = z.infer<typeof PatchLaneRequest>;

/**
 * One change to a lane or, with no `lane`, to what a project's lanes share. No `snapshot` means the
 * lane was removed.
 * generated from [LaneRevision](../../data/contracts/stages.ck)
 */
export const LaneRevision = z.strictObject({
    id: z.string(),
    lane: z.string().optional(),
    snapshot: _ZodJson.optional(),
    message: z.string(),
    createdAt: _ZodDatetime,
});
export type LaneRevision = z.infer<typeof LaneRevision>;

/**
 * generated from [LaneRevisionsQuery](../../data/contracts/stages.ck)
 */
export const LaneRevisionsQuery = z.strictObject({
    lane: z.string().optional(),
    limit: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()).optional(),
});
export type LaneRevisionsQuery = z.infer<typeof LaneRevisionsQuery>;
