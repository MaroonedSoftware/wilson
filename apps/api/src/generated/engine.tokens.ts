import { z } from 'zod';
import { DateTime } from 'luxon';

const _ZodDatetime = z.preprocess(
    val => (typeof val === 'string' ? DateTime.fromISO(val) : val),
    z.custom<DateTime>(val => val instanceof DateTime && val.isValid, { message: 'Must be in ISO 8601 format' }),
);

/**
 * What is shown of a saved token: its name and when it was saved, never the token.
 * generated from [EngineTokenSummary](../../data/contracts/engine.tokens.ck)
 */
export const EngineTokenSummary = z.strictObject({
    name: z.string(),
    createdAt: _ZodDatetime,
    updatedAt: _ZodDatetime,
});
export type EngineTokenSummary = z.infer<typeof EngineTokenSummary>;

/**
 * generated from [PutEngineTokenRequest](../../data/contracts/engine.tokens.ck)
 */
export const PutEngineTokenRequest = z.strictObject({
    token: z.string().describe('What `claude setup-token` prints.'),
});
export type PutEngineTokenRequest = z.infer<typeof PutEngineTokenRequest>;
