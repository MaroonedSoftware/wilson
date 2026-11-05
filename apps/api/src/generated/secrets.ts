import { z } from 'zod';
import { DateTime } from 'luxon';

const _ZodDatetime = z.preprocess(
    val => (typeof val === 'string' ? DateTime.fromISO(val) : val),
    z.custom<DateTime>(val => val instanceof DateTime && val.isValid, { message: 'Must be in ISO 8601 format' }),
);

/**
 * What is shown of a saved secret: its name and when it was saved, never its value.
 * generated from [SecretSummary](../../data/contracts/secrets.ck)
 */
export const SecretSummary = z.strictObject({
    name: z.string(),
    createdAt: _ZodDatetime,
    updatedAt: _ZodDatetime,
});
export type SecretSummary = z.infer<typeof SecretSummary>;

/**
 * generated from [PutSecretRequest](../../data/contracts/secrets.ck)
 */
export const PutSecretRequest = z.strictObject({
    value: z.string(),
});
export type PutSecretRequest = z.infer<typeof PutSecretRequest>;
