import { z } from 'zod';
import { DateTime } from 'luxon';

const _ZodDatetime = z.preprocess(
    val => (typeof val === 'string' ? DateTime.fromISO(val) : val),
    z.custom<DateTime>(val => val instanceof DateTime && val.isValid, { message: 'Must be in ISO 8601 format' }),
);

/**
 * generated from [Goal](../../data/contracts/goals.ck)
 */
export const Goal = z.strictObject({
    id: z.string(),
    threadId: z.string(),
    project: z.string(),
    title: z.string(),
    outcome: z.string().describe("What done looks like, in the person's terms."),
    status: z.enum(['active', 'paused', 'done', 'abandoned']),
    createdAt: _ZodDatetime,
    updatedAt: _ZodDatetime,
});
export type Goal = z.infer<typeof Goal>;

/**
 * A card as a goal shows it.
 * generated from [GoalCard](../../data/contracts/goals.ck)
 */
export const GoalCard = z.strictObject({
    id: z.string(),
    title: z.string(),
    stage: z.string(),
    needsHuman: z.preprocess(v => (v === 'true' ? true : v === 'false' ? false : v), z.boolean()),
});
export type GoalCard = z.infer<typeof GoalCard>;

/**
 * generated from [ListGoalsQuery](../../data/contracts/goals.ck)
 */
export const ListGoalsQuery = z.strictObject({
    project: z.string().optional(),
    status: z.enum(['active', 'paused', 'done', 'abandoned']).optional(),
    threadId: z.string().optional(),
});
export type ListGoalsQuery = z.infer<typeof ListGoalsQuery>;

/**
 * generated from [CreateGoalRequest](../../data/contracts/goals.ck)
 */
export const CreateGoalRequest = z.strictObject({
    threadId: z.string().describe('The thread that sees it through, which has no goal yet.'),
    project: z.string(),
    title: z.string(),
    outcome: z.string(),
});
export type CreateGoalRequest = z.infer<typeof CreateGoalRequest>;

/**
 * generated from [UpdateGoalRequest](../../data/contracts/goals.ck)
 */
export const UpdateGoalRequest = z.strictObject({
    title: z.string().optional(),
    outcome: z.string().optional(),
    status: z.enum(['active', 'paused', 'done', 'abandoned']).optional(),
});
export type UpdateGoalRequest = z.infer<typeof UpdateGoalRequest>;

/**
 * generated from [GoalDetail](../../data/contracts/goals.ck)
 */
export const GoalDetail = z.strictObject({
    goal: Goal,
    cards: z.array(GoalCard),
});
export type GoalDetail = z.infer<typeof GoalDetail>;
