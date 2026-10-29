import { DateTime } from 'luxon';
import type { PasskeyAttestationCredential } from './passkey.types.js';
import type { PasskeyCreationOptions } from './passkey.types.js';

const __dt = (v: unknown, path: string): DateTime => {
    if (typeof v !== 'string') {
        throw new TypeError(`ContractKit: expected an ISO 8601 string at '${path}', received ${typeof v}.`);
    }
    const d = DateTime.fromISO(v);
    if (!d.isValid) throw new TypeError(`ContractKit: '${v}' at '${path}' is not a valid ISO 8601 datetime.`);
    return d;
};

/**
 * generated from [SecondFactorMethod](../../../../apps/api/data/contracts/factors.ck)
 */
export type SecondFactorMethod = 'authenticator' | 'passkey';

/**
 * generated from [StartAuthenticatorRequest](../../../../apps/api/data/contracts/factors.ck)
 */
export interface StartAuthenticatorRequest {
    /** What the authenticator app shows beside the code, after the issuer. */
    label?: string;
}

/**
 * What to scan. `uri` is the `otpauth://` URI, `qrCode` the same as a PNG data URL, and `secret` the
 * base32 seed for an app that cannot scan. Nothing is enrolled until a code from the app is checked
 * (`verify`), within ten minutes.
 * generated from [AuthenticatorRegistration](../../../../apps/api/data/contracts/factors.ck)
 */
export interface AuthenticatorRegistration {
    registrationId: string;
    uri: string;
    qrCode: string;
    secret: string;
}

/**
 * generated from [VerifyAuthenticatorRequest](../../../../apps/api/data/contracts/factors.ck)
 */
export interface VerifyAuthenticatorRequest {
    registrationId: string;
    code: string;
}

/**
 * generated from [StartPasskeyRequest](../../../../apps/api/data/contracts/factors.ck)
 */
export interface StartPasskeyRequest {
    /** A name to tell this passkey apart from others, such as the device it is on. */
    label?: string;
}

/**
 * What to call `navigator.credentials.create` with. Nothing is enrolled until the browser's answer is
 * checked (`passkey/verify`).
 * generated from [PasskeyRegistration](../../../../apps/api/data/contracts/factors.ck)
 */
export interface PasskeyRegistration {
    registrationId: string;
    options: PasskeyCreationOptions;
}

/**
 * generated from [VerifyPasskeyRequest](../../../../apps/api/data/contracts/factors.ck)
 */
export interface VerifyPasskeyRequest {
    registrationId: string;
    credential: PasskeyAttestationCredential;
}

/**
 * generated from [SecondFactorSummary](../../../../apps/api/data/contracts/factors.ck)
 */
export interface SecondFactorSummary {
    id: string;
    method: SecondFactorMethod;
    label?: string;
    createdAt: DateTime;
}

/** Rehydrates every wire-encoded scalar in a SecondFactorSummary into its runtime type. Mutates and returns `raw`. */
export function reviveSecondFactorSummary(raw: SecondFactorSummary): SecondFactorSummary {
    const __o0 = raw as unknown as Record<string, unknown>;
    __o0['createdAt'] = __dt(__o0['createdAt'], 'SecondFactorSummary.createdAt');
    return raw;
}
