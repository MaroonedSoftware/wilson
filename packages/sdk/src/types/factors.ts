import type { PasskeyAttestationCredential } from './passkey.types.js';
import type { PasskeyCreationOptions } from './passkey.types.js';

/**
 * generated from [SecondFactorMethod](file://./../../../../apps/api/data/contracts/factors.ck#L20)
 */
export type SecondFactorMethod = 'authenticator' | 'passkey';

/**
 * generated from [StartAuthenticatorRequest](file://./../../../../apps/api/data/contracts/factors.ck#L29)
 */
export interface StartAuthenticatorRequest {
    /** What the authenticator app shows beside the code, after the issuer. */
    label?: string;
}

/**
 * What to scan. `uri` is the `otpauth://` URI, `qrCode` the same as a PNG data URL, and `secret` the
 * base32 seed for an app that cannot scan. Nothing is enrolled until a code from the app is checked
 * (`verify`), within ten minutes.
 * generated from [AuthenticatorRegistration](file://./../../../../apps/api/data/contracts/factors.ck#L37)
 */
export interface AuthenticatorRegistration {
    registrationId: string;
    uri: string;
    qrCode: string;
    secret: string;
}

/**
 * generated from [VerifyAuthenticatorRequest](file://./../../../../apps/api/data/contracts/factors.ck#L44)
 */
export interface VerifyAuthenticatorRequest {
    registrationId: string;
    code: string;
}

/**
 * generated from [StartPasskeyRequest](file://./../../../../apps/api/data/contracts/factors.ck#L49)
 */
export interface StartPasskeyRequest {
    /** A name to tell this passkey apart from others, such as the device it is on. */
    label?: string;
}

/**
 * What to call `navigator.credentials.create` with. Nothing is enrolled until the browser's answer is
 * checked (`passkey/verify`).
 * generated from [PasskeyRegistration](file://./../../../../apps/api/data/contracts/factors.ck#L56)
 */
export interface PasskeyRegistration {
    registrationId: string;
    options: PasskeyCreationOptions;
}

/**
 * generated from [VerifyPasskeyRequest](file://./../../../../apps/api/data/contracts/factors.ck#L61)
 */
export interface VerifyPasskeyRequest {
    registrationId: string;
    credential: PasskeyAttestationCredential;
}

/**
 * generated from [SecondFactorSummary](file://./../../../../apps/api/data/contracts/factors.ck#L22)
 */
export interface SecondFactorSummary {
    id: string;
    method: SecondFactorMethod;
    label?: string;
    createdAt: string;
}
