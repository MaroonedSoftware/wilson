import { z } from 'zod';
import { DateTime } from 'luxon';

const _ZodDatetime = z.preprocess(
    val => (typeof val === 'string' ? DateTime.fromISO(val) : val),
    z.custom<DateTime>(val => val instanceof DateTime && val.isValid, { message: 'Must be in ISO 8601 format' }),
);

/**
 * Who a token signs in to.
 * generated from [EngineTokenProvider](../../data/contracts/engine.tokens.ck)
 */
export const EngineTokenProvider = z.enum(['anthropic', 'openai', 'xai']);
export type EngineTokenProvider = z.infer<typeof EngineTokenProvider>;

/**
 * How it signs in: a plan's own login, or a key billed per token.
 * generated from [EngineTokenKind](../../data/contracts/engine.tokens.ck)
 */
export const EngineTokenKind = z.enum(['subscription', 'api_key']);
export type EngineTokenKind = z.infer<typeof EngineTokenKind>;

/**
 * A usage limit an account has hit that has not reset. `account` is a saved token's name, `local` for
 * the sign-in of engines on this machine, or `worker:<host>` for a worker's own.
 * generated from [EngineLimit](../../data/contracts/engine.tokens.ck)
 */
export const EngineLimit = z.strictObject({
    account: z.string(),
    limitType: z.string(),
    resetsAt: _ZodDatetime,
});
export type EngineLimit = z.infer<typeof EngineLimit>;

/**
 * How many days `GET /api/engine-accounts/usage` reads, today included. Defaults to 30, and is held to
 * between 1 and 365. A day starts at the server's midnight, as in `GET /api/stats`.
 * generated from [EngineAccountUsageQuery](../../data/contracts/engine.tokens.ck)
 */
export const EngineAccountUsageQuery = z.strictObject({
    days: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()).optional(),
});
export type EngineAccountUsageQuery = z.infer<typeof EngineAccountUsageQuery>;

/**
 * What one engine account spent, across every project: stage runs, chat turns and planning turns. `account`
 * is named as `EngineLimit.account` is. `inputTokens` includes `cachedInputTokens`, as in `ProjectStatsCounts`.
 * Spend recorded before accounts were named, by the `api` engine, by a rule judge, or in a review
 * conversation, is in no row.
 * generated from [EngineAccountUsage](../../data/contracts/engine.tokens.ck)
 */
export const EngineAccountUsage = z.strictObject({
    account: z.string(),
    todayOutputTokens: z
        .preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int())
        .describe("Output tokens since the server's midnight."),
    outputTokens: z
        .preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int())
        .describe('The rest are over the whole window.'),
    inputTokens: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()),
    cachedInputTokens: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()),
});
export type EngineAccountUsage = z.infer<typeof EngineAccountUsage>;

/**
 * What is shown of a saved token: its name, what it signs in to and when it was saved, never the token.
 * generated from [EngineTokenSummary](../../data/contracts/engine.tokens.ck)
 */
export const EngineTokenSummary = z.strictObject({
    name: z.string(),
    provider: EngineTokenProvider,
    kind: EngineTokenKind,
    priority: z
        .preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int())
        .describe("Which of a provider's tokens comes first, lowest first."),
    pooled: z
        .preprocess(v => (v === 'true' ? true : v === 'false' ? false : v), z.boolean())
        .describe('Whether Wilson may choose this token for an engine with no token assigned.'),
    createdAt: _ZodDatetime,
    updatedAt: _ZodDatetime,
    hosts: z.array(z.string()).describe('The worker hosts assigned this token, name ascending.'),
});
export type EngineTokenSummary = z.infer<typeof EngineTokenSummary>;

/**
 * generated from [PutEngineTokenRequest](../../data/contracts/engine.tokens.ck)
 */
export const PutEngineTokenRequest = z.strictObject({
    token: z.string().describe('What `claude setup-token` prints, or an API key. An OpenAI token has to be an API key.'),
    provider: EngineTokenProvider.optional().describe(
        'Each of these keeps what is saved under this name when left out, or its default on a new name:\nanthropic, subscription, 0 and not pooled.',
    ),
    kind: EngineTokenKind.optional(),
    priority: z
        .preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int())
        .optional()
        .describe('0 to 1000.'),
    pooled: z.preprocess(v => (v === 'true' ? true : v === 'false' ? false : v), z.boolean()).optional(),
});
export type PutEngineTokenRequest = z.infer<typeof PutEngineTokenRequest>;

/**
 * What can change about a saved token without saving it again. What is left out stays as it is.
 * generated from [UpdateEngineTokenRequest](../../data/contracts/engine.tokens.ck)
 */
export const UpdateEngineTokenRequest = z.strictObject({
    provider: EngineTokenProvider.optional(),
    kind: EngineTokenKind.optional(),
    priority: z
        .preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int())
        .optional()
        .describe('0 to 1000.'),
    pooled: z.preprocess(v => (v === 'true' ? true : v === 'false' ? false : v), z.boolean()).optional(),
});
export type UpdateEngineTokenRequest = z.infer<typeof UpdateEngineTokenRequest>;
