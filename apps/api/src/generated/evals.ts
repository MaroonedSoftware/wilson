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
 * One past attempt, kept to be run again. `warnings` is only ever filled when capturing one.
 * generated from [EvalFixture](../../data/contracts/evals.ck)
 */
export const EvalFixture = z.strictObject({
    id: z.string(),
    sourceCardId: z.string(),
    title: z.string(),
    stage: z.string(),
    planVersionId: z.string(),
    baseSha: z.string(),
    headSha: z.string(),
    warnings: z.array(z.string()),
    createdAt: _ZodDatetime,
});
export type EvalFixture = z.infer<typeof EvalFixture>;

/**
 * `attempt` counts from 1, oldest first, and defaults to the card's latest attempt at that stage.
 * generated from [CaptureEvalFixtureRequest](../../data/contracts/evals.ck)
 */
export const CaptureEvalFixtureRequest = z.strictObject({
    cardId: z.string(),
    stage: z.string(),
    attempt: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()).optional(),
});
export type CaptureEvalFixtureRequest = z.infer<typeof CaptureEvalFixtureRequest>;

/**
 * A change to try on one lane, never saved. With nothing but `lane` it changes nothing, which makes an
 * A/A batch: both arms the same, to measure how much runs differ by chance.
 * generated from [LaneCandidate](../../data/contracts/evals.ck)
 */
export const LaneCandidate = z.strictObject({
    lane: z.string(),
    instructions: z.string().optional(),
    settings: _ZodJson.optional(),
    adapter: z.string().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
});
export type LaneCandidate = z.infer<typeof LaneCandidate>;

/**
 * One run of one fixture. `interrupted` and `abandoned` say nothing about the config, and are counted
 * apart from `passed` and `failed`.
 * generated from [EvalRun](../../data/contracts/evals.ck)
 */
export const EvalRun = z.strictObject({
    id: z.string(),
    fixtureId: z.string(),
    arm: z.enum(['current', 'candidate']),
    status: z.enum(['queued', 'running', 'passed', 'failed', 'errored', 'interrupted', 'abandoned', 'skipped']),
    failures: z.array(z.string()),
    unjudged: z.preprocess(v => (v === 'true' ? true : v === 'false' ? false : v), z.boolean()),
    reportRejected: z.preprocess(v => (v === 'true' ? true : v === 'false' ? false : v), z.boolean()),
    truncated: z.preprocess(v => (v === 'true' ? true : v === 'false' ? false : v), z.boolean()),
    hasPatch: z.preprocess(v => (v === 'true' ? true : v === 'false' ? false : v), z.boolean()),
    error: z.string().optional(),
    wallClockMs: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()).optional(),
    inputTokens: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()).optional(),
    cachedInputTokens: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()).optional(),
    outputTokens: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()).optional(),
    toolCalls: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()).optional(),
    scopeDenials: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()).optional(),
});
export type EvalRun = z.infer<typeof EvalRun>;

/**
 * generated from [EvalSpread](../../data/contracts/evals.ck)
 */
export const EvalSpread = z.strictObject({
    median: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()),
    min: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()),
    max: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()),
});
export type EvalSpread = z.infer<typeof EvalSpread>;

/**
 * generated from [EvalFailureCount](../../data/contracts/evals.ck)
 */
export const EvalFailureCount = z.strictObject({
    reason: z.string(),
    count: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()),
});
export type EvalFailureCount = z.infer<typeof EvalFailureCount>;

/**
 * generated from [EvalRunPatch](../../data/contracts/evals.ck)
 */
export const EvalRunPatch = z.strictObject({
    patch: z.string(),
    truncated: z.preprocess(v => (v === 'true' ? true : v === 'false' ? false : v), z.boolean()),
});
export type EvalRunPatch = z.infer<typeof EvalRunPatch>;

/**
 * generated from [ListEvalBatchesQuery](../../data/contracts/evals.ck)
 */
export const ListEvalBatchesQuery = z.strictObject({
    limit: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()).optional(),
});
export type ListEvalBatchesQuery = z.infer<typeof ListEvalBatchesQuery>;

/**
 * One batch: fixtures run again on one host, up to a limit on what it spends. `waitingReason` says why
 * nothing is running right now, such as a host with no slot free.
 * generated from [EvalBatch](../../data/contracts/evals.ck)
 */
export const EvalBatch = z.strictObject({
    id: z.string(),
    status: z.enum(['running', 'finished', 'stopped']),
    host: z.string(),
    runsPerFixture: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()),
    maxOutputTokens: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()),
    spentOutputTokens: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()),
    candidate: LaneCandidate.optional(),
    stopReason: z.string().optional(),
    waitingReason: z.string().optional(),
    createdAt: _ZodDatetime,
    finishedAt: _ZodDatetime.optional(),
});
export type EvalBatch = z.infer<typeof EvalBatch>;

/**
 * `runs` is per fixture and per arm, and defaults to 3. `maxOutputTokens` defaults to 300000. With a
 * `candidate`, every fixture must be an attempt at the lane it changes, and the arms alternate.
 * generated from [CreateEvalBatchRequest](../../data/contracts/evals.ck)
 */
export const CreateEvalBatchRequest = z.strictObject({
    fixtureIds: z.array(z.string()),
    host: z.string(),
    candidate: LaneCandidate.optional(),
    runs: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()).optional(),
    maxOutputTokens: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()).optional(),
});
export type CreateEvalBatchRequest = z.infer<typeof CreateEvalBatchRequest>;

/**
 * One arm across every fixture in the batch.
 * generated from [EvalArmTotal](../../data/contracts/evals.ck)
 */
export const EvalArmTotal = z.strictObject({
    arm: z.enum(['current', 'candidate']),
    passed: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()),
    failed: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()),
    errored: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()),
    interrupted: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()),
    pending: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()),
    outputTokens: EvalSpread.optional(),
    wallClockMs: EvalSpread.optional(),
});
export type EvalArmTotal = z.infer<typeof EvalArmTotal>;

/**
 * One arm on one fixture. There is no verdict here on purpose: with a handful of runs, the honest
 * report is the counts and the spread.
 * generated from [EvalArmSummary](../../data/contracts/evals.ck)
 */
export const EvalArmSummary = z.strictObject({
    fixtureId: z.string(),
    arm: z.enum(['current', 'candidate']),
    passed: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()),
    failed: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()),
    errored: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()),
    interrupted: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()),
    pending: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()),
    outputTokens: EvalSpread.optional(),
    wallClockMs: EvalSpread.optional(),
    failures: z.array(EvalFailureCount),
});
export type EvalArmSummary = z.infer<typeof EvalArmSummary>;

/**
 * generated from [EvalBatchDetail](../../data/contracts/evals.ck)
 */
export const EvalBatchDetail = z.strictObject({
    batch: EvalBatch,
    runs: z.array(EvalRun),
    summary: z.array(EvalArmSummary),
    totals: z.array(EvalArmTotal),
});
export type EvalBatchDetail = z.infer<typeof EvalBatchDetail>;
