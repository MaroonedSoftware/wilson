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
    token: z.string().describe('What `claude setup-token` prints.'),
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
