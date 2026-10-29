import { z } from 'zod';
import { DateTime } from 'luxon';

const _ZodDatetime = z.preprocess(
    val => (typeof val === 'string' ? DateTime.fromISO(val) : val),
    z.custom<DateTime>(val => val instanceof DateTime && val.isValid, { message: 'Must be in ISO 8601 format' }),
);

/**
 * What a key may do. `manage` includes `view`.
 * generated from [ApiKeyScope](../../data/contracts/api.keys.ck)
 */
export const ApiKeyScope = z.enum(['view', 'manage']);
export type ApiKeyScope = z.infer<typeof ApiKeyScope>;

/**
 * A key as the list shows it. `hint` is the last few characters of the token, to tell keys apart.
 * generated from [ApiKeySummary](../../data/contracts/api.keys.ck)
 */
export const ApiKeySummary = z.strictObject({
    id: z.string(),
    name: z.string(),
    hint: z.string(),
    scope: ApiKeyScope,
    createdAt: _ZodDatetime,
    expiresAt: _ZodDatetime.optional(),
    lastUsedAt: _ZodDatetime.optional(),
    revokedAt: _ZodDatetime.optional(),
});
export type ApiKeySummary = z.infer<typeof ApiKeySummary>;

/**
 * generated from [CreateApiKeyRequest](../../data/contracts/api.keys.ck)
 */
export const CreateApiKeyRequest = z.strictObject({
    name: z.string().min(1).max(100),
    scope: ApiKeyScope,
    expiresInDays: z
        .preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().min(1).max(3650))
        .optional()
        .describe('Unset means the key does not expire.'),
});
export type CreateApiKeyRequest = z.infer<typeof CreateApiKeyRequest>;

/**
 * A newly created or rotated key and its token. The only time the token is ever returned.
 * generated from [IssuedApiKey](../../data/contracts/api.keys.ck)
 */
export const IssuedApiKey = z.strictObject({
    key: ApiKeySummary,
    token: z.string(),
});
export type IssuedApiKey = z.infer<typeof IssuedApiKey>;
