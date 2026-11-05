import { z } from 'zod';
import { DateTime } from 'luxon';

const _ZodDatetime = z.preprocess(
    val => (typeof val === 'string' ? DateTime.fromISO(val) : val),
    z.custom<DateTime>(val => val instanceof DateTime && val.isValid, { message: 'Must be in ISO 8601 format' }),
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
