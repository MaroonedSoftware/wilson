import { z } from 'zod';
import { DateTime } from 'luxon';
import { PasskeyAttestationCredential } from './passkey.types.js';
import { PasskeyCreationOptions } from './passkey.types.js';

const _ZodDatetime = z.preprocess(
    val => (typeof val === 'string' ? DateTime.fromISO(val) : val),
    z.custom<DateTime>(val => val instanceof DateTime && val.isValid, { message: 'Must be in ISO 8601 format' }),
);

/**
 * generated from [SecondFactorMethod](../../data/contracts/factors.ck)
 */
export const SecondFactorMethod = z.enum(['authenticator', 'passkey']);
export type SecondFactorMethod = z.infer<typeof SecondFactorMethod>;

/**
 * generated from [StartAuthenticatorRequest](../../data/contracts/factors.ck)
 */
export const StartAuthenticatorRequest = z.strictObject({
    label: z.string().max(64).optional().describe('What the authenticator app shows beside the code, after the issuer.'),
});
export type StartAuthenticatorRequest = z.infer<typeof StartAuthenticatorRequest>;

/**
 * What to scan. `uri` is the `otpauth://` URI, `qrCode` the same as a PNG data URL, and `secret` the
 * base32 seed for an app that cannot scan. Nothing is enrolled until a code from the app is checked
 * (`verify`), within ten minutes.
 * generated from [AuthenticatorRegistration](../../data/contracts/factors.ck)
 */
export const AuthenticatorRegistration = z.strictObject({
    registrationId: z.string(),
    uri: z.string(),
    qrCode: z.string(),
    secret: z.string(),
});
export type AuthenticatorRegistration = z.infer<typeof AuthenticatorRegistration>;

/**
 * generated from [VerifyAuthenticatorRequest](../../data/contracts/factors.ck)
 */
export const VerifyAuthenticatorRequest = z.strictObject({
    registrationId: z.string(),
    code: z.string().min(6).max(10),
});
export type VerifyAuthenticatorRequest = z.infer<typeof VerifyAuthenticatorRequest>;

/**
 * generated from [StartPasskeyRequest](../../data/contracts/factors.ck)
 */
export const StartPasskeyRequest = z.strictObject({
    label: z.string().max(64).optional().describe('A name to tell this passkey apart from others, such as the device it is on.'),
});
export type StartPasskeyRequest = z.infer<typeof StartPasskeyRequest>;

/**
 * What to call `navigator.credentials.create` with. Nothing is enrolled until the browser's answer is
 * checked (`passkey/verify`).
 * generated from [PasskeyRegistration](../../data/contracts/factors.ck)
 */
export const PasskeyRegistration = z.strictObject({
    registrationId: z.string(),
    options: PasskeyCreationOptions,
});
export type PasskeyRegistration = z.infer<typeof PasskeyRegistration>;

/**
 * generated from [VerifyPasskeyRequest](../../data/contracts/factors.ck)
 */
export const VerifyPasskeyRequest = z.strictObject({
    registrationId: z.string(),
    credential: PasskeyAttestationCredential,
});
export type VerifyPasskeyRequest = z.infer<typeof VerifyPasskeyRequest>;

/**
 * generated from [SecondFactorSummary](../../data/contracts/factors.ck)
 */
export const SecondFactorSummary = z.strictObject({
    id: z.string(),
    method: SecondFactorMethod,
    label: z.string().optional(),
    createdAt: _ZodDatetime,
});
export type SecondFactorSummary = z.infer<typeof SecondFactorSummary>;
