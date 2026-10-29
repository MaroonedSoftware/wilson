import { z } from 'zod';
import { DateTime } from 'luxon';

const _ZodDatetime = z.preprocess(
    val => (typeof val === 'string' ? DateTime.fromISO(val) : val),
    z.custom<DateTime>(val => val instanceof DateTime && val.isValid, { message: 'Must be in ISO 8601 format' }),
);

/**
 * generated from [TokenRequest](file://./../../data/contracts/auth.ck#L18)
 */
export const TokenRequest = z.strictObject({
    grant_type: z.enum(['password', 'refresh_token']),
    username: z.string().max(64).optional().describe('`password` grant.'),
    password: z.string().max(256).optional(),
    refresh_token: z.string().optional().describe('`refresh_token` grant.'),
});
export type TokenRequest = z.infer<typeof TokenRequest>;

/**
 * A signed-in session. `accessToken` goes in `Authorization: Bearer` on every request, and lasts as
 * long as the session (`expiresIn` seconds) unless the session is revoked first. `refreshToken` is
 * single-use: trading it in returns a new one, and presenting a spent one revokes the session.
 *
 * A caller that sends `x-wilson-cookies: 1` (the web app) gets no `refreshToken` here: it arrives as
 * an httpOnly cookie instead, and a `refresh_token` grant with none in the body redeems that cookie.
 * generated from [TokenResponse](file://./../../data/contracts/auth.ck#L33)
 */
export const TokenResponse = z.strictObject({
    accessToken: z.string(),
    refreshToken: z.string().optional(),
    expiresIn: z.coerce.number(),
    tokenType: z.string(),
});
export type TokenResponse = z.infer<typeof TokenResponse>;

/**
 * The session the caller's bearer token names.
 * generated from [CurrentSession](file://./../../data/contracts/auth.ck#L41)
 */
export const CurrentSession = z.strictObject({
    accountId: z.string(),
    username: z.string(),
    issuedAt: _ZodDatetime,
    expiresAt: _ZodDatetime,
});
export type CurrentSession = z.infer<typeof CurrentSession>;
