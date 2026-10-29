import { z } from 'zod';
import { DateTime } from 'luxon';
import { PasskeyAssertionCredential } from './passkey.types.js';
import { PasskeyRequestOptions } from './passkey.types.js';

const _ZodDatetime = z.preprocess(
    val => (typeof val === 'string' ? DateTime.fromISO(val) : val),
    z.custom<DateTime>(val => val instanceof DateTime && val.isValid, { message: 'Must be in ISO 8601 format' }),
);

/**
 * generated from [TokenRequest](file://./../../data/contracts/auth.ck#L18)
 */
export const TokenRequest = z.strictObject({
    grant_type: z.enum(['password', 'refresh_token', 'authenticator', 'passkey']),
    username: z.string().max(64).optional().describe('`password` grant.'),
    password: z.string().max(256).optional(),
    refresh_token: z.string().optional().describe('`refresh_token` grant.'),
    challenge_id: z
        .string()
        .optional()
        .describe(
            '`authenticator` grant: the second step after a `password` grant answered `mfa_required`.\n`factor_id` may be left out when only one authenticator is enrolled.',
        ),
    factor_id: z.string().optional(),
    code: z.string().max(10).optional(),
    passkey_challenge_id: z
        .string()
        .optional()
        .describe(
            "`passkey` grant: the other second step, with `challenge_id` as above, the passkey challenge\n`POST /api/auth/passkey/challenge` issued, and the browser's answer to it.",
        ),
    credential: PasskeyAssertionCredential.optional(),
});
export type TokenRequest = z.infer<typeof TokenRequest>;

/**
 * A second factor a sign-in may be completed with, as `mfa_required` lists them.
 * generated from [MfaFactor](file://./../../data/contracts/auth.ck#L37)
 */
export const MfaFactor = z.strictObject({
    method: z.enum(['authenticator', 'passkey']),
    id: z.string(),
    label: z.string().optional(),
});
export type MfaFactor = z.infer<typeof MfaFactor>;

/**
 * generated from [PasskeyChallengeRequest](file://./../../data/contracts/auth.ck#L63)
 */
export const PasskeyChallengeRequest = z.strictObject({
    challenge_id: z.string(),
});
export type PasskeyChallengeRequest = z.infer<typeof PasskeyChallengeRequest>;

/**
 * What to call `navigator.credentials.get` with to complete a sign-in, and the id the `passkey`
 * grant names it by.
 * generated from [PasskeyChallenge](file://./../../data/contracts/auth.ck#L69)
 */
export const PasskeyChallenge = z.strictObject({
    passkeyChallengeId: z.string(),
    options: PasskeyRequestOptions,
});
export type PasskeyChallenge = z.infer<typeof PasskeyChallenge>;

/**
 * The session the caller's bearer token names.
 * generated from [CurrentSession](file://./../../data/contracts/auth.ck#L75)
 */
export const CurrentSession = z.strictObject({
    accountId: z.string(),
    username: z.string(),
    issuedAt: _ZodDatetime,
    expiresAt: _ZodDatetime,
});
export type CurrentSession = z.infer<typeof CurrentSession>;

/**
 * A signed-in session. `accessToken` goes in `Authorization: Bearer` on every request, and lasts as
 * long as the session (`expiresIn` seconds) unless the session is revoked first. `refreshToken` is
 * single-use: trading it in returns a new one, and presenting a spent one revokes the session.
 *
 * A caller that sends `x-wilson-cookies: 1` (the web app) gets no `refreshToken` here: it arrives as
 * an httpOnly cookie instead, and a `refresh_token` grant with none in the body redeems that cookie.
 *
 * With a second factor enrolled, a correct password answers `result: mfa_required` instead, with no
 * tokens: `challengeId` and the `factors` to choose from, for an `authenticator` grant to complete
 * within five minutes. Otherwise `result` is `token`.
 * generated from [TokenResponse](file://./../../data/contracts/auth.ck#L53)
 */
export const TokenResponse = z.strictObject({
    result: z.enum(['token', 'mfa_required']),
    accessToken: z.string().optional(),
    refreshToken: z.string().optional(),
    expiresIn: z.coerce.number().optional(),
    tokenType: z.string().optional(),
    challengeId: z.string().optional(),
    factors: z.array(MfaFactor).optional(),
});
export type TokenResponse = z.infer<typeof TokenResponse>;
