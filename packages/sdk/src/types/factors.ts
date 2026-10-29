/**
 * generated from [SecondFactorMethod](file://./../../../../apps/api/data/contracts/factors.ck#L19)
 */
export type SecondFactorMethod = 'authenticator';

/**
 * generated from [StartAuthenticatorRequest](file://./../../../../apps/api/data/contracts/factors.ck#L28)
 */
export interface StartAuthenticatorRequest {
    /** What the authenticator app shows beside the code, after the issuer. */
    label?: string;
}

/**
 * What to scan. `uri` is the `otpauth://` URI, `qrCode` the same as a PNG data URL, and `secret` the
 * base32 seed for an app that cannot scan. Nothing is enrolled until a code from the app is checked
 * (`verify`), within ten minutes.
 * generated from [AuthenticatorRegistration](file://./../../../../apps/api/data/contracts/factors.ck#L36)
 */
export interface AuthenticatorRegistration {
    registrationId: string;
    uri: string;
    qrCode: string;
    secret: string;
}

/**
 * generated from [VerifyAuthenticatorRequest](file://./../../../../apps/api/data/contracts/factors.ck#L43)
 */
export interface VerifyAuthenticatorRequest {
    registrationId: string;
    code: string;
}

/**
 * generated from [SecondFactorSummary](file://./../../../../apps/api/data/contracts/factors.ck#L21)
 */
export interface SecondFactorSummary {
    id: string;
    method: SecondFactorMethod;
    label?: string;
    createdAt: string;
}
