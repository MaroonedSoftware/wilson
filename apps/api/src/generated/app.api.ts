import { z } from 'zod';
import { DateTime } from 'luxon';

const _ZodDatetime = z.preprocess(
    val => (typeof val === 'string' ? DateTime.fromISO(val) : val),
    z.custom<DateTime>(val => val instanceof DateTime && val.isValid, { message: 'Must be in ISO 8601 format' }),
);

/**
 * generated from [AppV1DoneReason](../../data/contracts/app.api.ck)
 */
export const AppV1DoneReason = z.enum(['merged', 'poisoned', 'dropped', 'split']);
export type AppV1DoneReason = z.infer<typeof AppV1DoneReason>;

/**
 * What pressing Merge on a `ready` card would do right now.
 * generated from [AppV1MergeStatus](../../data/contracts/app.api.ck)
 */
export const AppV1MergeStatus = z.strictObject({
    state: z.enum(['clean', 'conflict', 'rereview', 'capped', 'unknown']),
    target: z.string().optional(),
    conflicts: z.array(z.string()),
    movedUnder: z.array(z.string()),
    reason: z.string().optional(),
});
export type AppV1MergeStatus = z.infer<typeof AppV1MergeStatus>;

/**
 * The question a stage stopped to ask.
 * generated from [AppV1CardBlocked](../../data/contracts/app.api.ck)
 */
export const AppV1CardBlocked = z.strictObject({
    category: z.enum(['decision', 'access', 'requirements', 'environment', 'other']),
    tried: z.string(),
    question: z.string(),
    options: z.array(z.string()).optional(),
    stage: z.string(),
    askedAt: _ZodDatetime,
});
export type AppV1CardBlocked = z.infer<typeof AppV1CardBlocked>;

/**
 * generated from [AppV1BoardColumns](../../data/contracts/app.api.ck)
 */
export const AppV1BoardColumns = z.strictObject({
    stages: z.array(z.string()),
    nonStages: z.array(z.string()),
});
export type AppV1BoardColumns = z.infer<typeof AppV1BoardColumns>;

/**
 * One thing that happened on the project, without the event's own payload, whose shape belongs to the event
 * log. `cardTitle` is null when the card no longer exists.
 * generated from [AppV1ActivityEvent](../../data/contracts/app.api.ck)
 */
export const AppV1ActivityEvent = z.strictObject({
    id: z.string(),
    cardId: z.string(),
    cardTitle: z.string().nullable(),
    type: z.string(),
    stage: z.string().nullable(),
    createdAt: _ZodDatetime,
});
export type AppV1ActivityEvent = z.infer<typeof AppV1ActivityEvent>;

/**
 * generated from [AppV1ActivityQuery](../../data/contracts/app.api.ck)
 */
export const AppV1ActivityQuery = z.strictObject({
    limit: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()).optional(),
    before: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()).optional(),
});
export type AppV1ActivityQuery = z.infer<typeof AppV1ActivityQuery>;

/**
 * generated from [AppV1StatsQuery](../../data/contracts/app.api.ck)
 */
export const AppV1StatsQuery = z.strictObject({
    days: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()).optional(),
});
export type AppV1StatsQuery = z.infer<typeof AppV1StatsQuery>;

/**
 * generated from [AppV1StatsCounts](../../data/contracts/app.api.ck)
 */
export const AppV1StatsCounts = z.strictObject({
    attempts: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()),
    passed: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()),
    failed: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()),
    interrupted: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()),
    inputTokens: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()),
    cachedInputTokens: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()),
    outputTokens: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()),
});
export type AppV1StatsCounts = z.infer<typeof AppV1StatsCounts>;

/**
 * generated from [AppV1ConversationStats](../../data/contracts/app.api.ck)
 */
export const AppV1ConversationStats = z.strictObject({
    kind: z.enum(['planning', 'review']),
    turns: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()),
    cards: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()),
    inputTokens: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()),
    cachedInputTokens: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()),
    outputTokens: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()),
});
export type AppV1ConversationStats = z.infer<typeof AppV1ConversationStats>;

/**
 * generated from [AppV1SplitPiece](../../data/contracts/app.api.ck)
 */
export const AppV1SplitPiece = z.strictObject({
    id: z.string(),
    title: z.string(),
    stage: z.string(),
    doneReason: AppV1DoneReason.optional(),
});
export type AppV1SplitPiece = z.infer<typeof AppV1SplitPiece>;

/**
 * generated from [AppV1Card](../../data/contracts/app.api.ck)
 */
export const AppV1Card = z.strictObject({
    id: z.string(),
    title: z.string(),
    stage: z.string(),
    doneReason: AppV1DoneReason.optional(),
    planCheck: z.enum(['checking', 'refused']).optional(),
    planCheckReason: z.string().optional(),
    branch: z.string().optional().describe("The branch the card's work is on, whether recorded or derived from its title."),
    dependsOn: z.array(z.string()),
    needsHuman: z.preprocess(v => (v === 'true' ? true : v === 'false' ? false : v), z.boolean()),
    needsHumanReason: z.string().optional(),
    blocked: AppV1CardBlocked.optional(),
    position: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()).optional(),
    splitFrom: z.string().optional(),
    stageEnteredAt: _ZodDatetime.optional(),
    mergeStatus: AppV1MergeStatus.optional(),
});
export type AppV1Card = z.infer<typeof AppV1Card>;

/**
 * generated from [AppV1StageStats](../../data/contracts/app.api.ck)
 */
export const AppV1StageStats = AppV1StatsCounts.extend({
    stage: z.string(),
    cards: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()),
});
export type AppV1StageStats = z.infer<typeof AppV1StageStats>;

/**
 * generated from [AppV1DayStats](../../data/contracts/app.api.ck)
 */
export const AppV1DayStats = AppV1StatsCounts.extend({
    date: z.string(),
});
export type AppV1DayStats = z.infer<typeof AppV1DayStats>;

/**
 * generated from [AppV1CardStats](../../data/contracts/app.api.ck)
 */
export const AppV1CardStats = AppV1StatsCounts.extend({
    cardId: z.string(),
    cardTitle: z.string().optional(),
});
export type AppV1CardStats = z.infer<typeof AppV1CardStats>;

/**
 * generated from [AppV1StatsTotal](../../data/contracts/app.api.ck)
 */
export const AppV1StatsTotal = AppV1StatsCounts.extend({
    cards: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()),
});
export type AppV1StatsTotal = z.infer<typeof AppV1StatsTotal>;

/**
 * generated from [AppV1CardDetail](../../data/contracts/app.api.ck)
 */
export const AppV1CardDetail = AppV1Card.extend({
    body: z.string(),
    sections: z.record(z.string(), z.string()),
    pieces: z.array(AppV1SplitPiece).optional(),
});
export type AppV1CardDetail = z.infer<typeof AppV1CardDetail>;

/**
 * generated from [AppV1Stats](../../data/contracts/app.api.ck)
 */
export const AppV1Stats = z.strictObject({
    since: _ZodDatetime,
    until: _ZodDatetime,
    zone: z.string(),
    total: AppV1StatsTotal,
    stages: z.array(AppV1StageStats),
    days: z.array(AppV1DayStats),
    topCards: z.array(AppV1CardStats),
    conversations: z.array(AppV1ConversationStats),
});
export type AppV1Stats = z.infer<typeof AppV1Stats>;
