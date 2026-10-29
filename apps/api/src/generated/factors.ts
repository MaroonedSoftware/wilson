import { z } from 'zod';
import { DateTime } from 'luxon';

const _ZodDatetime = z.preprocess(
    val => (typeof val === 'string' ? DateTime.fromISO(val) : val),
    z.custom<DateTime>(val => val instanceof DateTime && val.isValid, { message: 'Must be in ISO 8601 format' }),
);

/**
 * generated from [SecondFactorMethod](file://./../../data/contracts/factors.ck#L19)
 */
export const SecondFactorMethod = z.enum(['authenticator']);
export type SecondFactorMethod = z.infer<typeof SecondFactorMethod>;

/**
 * generated from [StartAuthenticatorRequest](file://./../../data/contracts/factors.ck#L28)
 */
export const StartAuthenticatorRequest = z.strictObject({
    label: z.string().max(64).optional().describe('What the authenticator app shows beside the code, after the issuer.'),
});
export type StartAuthenticatorRequest = z.infer<typeof StartAuthenticatorRequest>;

/**
 * What to scan. `uri` is the `otpauth://` URI, `qrCode` the same as a PNG data URL, and `secret` the
 * base32 seed for an app that cannot scan. Nothing is enrolled until a code from the app is checked
 * (`verify`), within ten minutes.
 * generated from [AuthenticatorRegistration](file://./../../data/contracts/factors.ck#L36)
 */
export const AuthenticatorRegistration = z.strictObject({
    registrationId: z.string(),
    uri: z.string(),
    qrCode: z.string(),
    secret: z.string(),
});
export type AuthenticatorRegistration = z.infer<typeof AuthenticatorRegistration>;

/**
 * generated from [VerifyAuthenticatorRequest](file://./../../data/contracts/factors.ck#L43)
 */
export const VerifyAuthenticatorRequest = z.strictObject({
    registrationId: z.string(),
    code: z.string().min(6).max(10),
});
export type VerifyAuthenticatorRequest = z.infer<typeof VerifyAuthenticatorRequest>;

/**
 * generated from [SecondFactorSummary](file://./../../data/contracts/factors.ck#L21)
 */
export const SecondFactorSummary = z.strictObject({
    id: z.string(),
    method: SecondFactorMethod,
    label: z.string().optional(),
    createdAt: _ZodDatetime,
});
export type SecondFactorSummary = z.infer<typeof SecondFactorSummary>;
