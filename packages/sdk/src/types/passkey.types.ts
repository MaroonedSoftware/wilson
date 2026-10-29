/**
 * generated from [PasskeyRelyingParty](file://./../../../../apps/api/data/contracts/passkey.types.ck#L6)
 */
export interface PasskeyRelyingParty {
    id: string;
    name: string;
}

/**
 * generated from [PasskeyUser](file://./../../../../apps/api/data/contracts/passkey.types.ck#L11)
 */
export interface PasskeyUser {
    id: string;
    name: string;
    displayName: string;
}

/**
 * generated from [PasskeyKeyParam](file://./../../../../apps/api/data/contracts/passkey.types.ck#L17)
 */
export interface PasskeyKeyParam {
    type: string;
    alg: number;
}

/**
 * generated from [PasskeyCredentialDescriptor](file://./../../../../apps/api/data/contracts/passkey.types.ck#L22)
 */
export interface PasskeyCredentialDescriptor {
    type: string;
    id: string;
    transports?: string[];
}

/**
 * generated from [PasskeyCredProps](file://./../../../../apps/api/data/contracts/passkey.types.ck#L47)
 */
export interface PasskeyCredProps {
    rk: boolean;
}

/**
 * generated from [PasskeyAttestationResponse](file://./../../../../apps/api/data/contracts/passkey.types.ck#L57)
 */
export interface PasskeyAttestationResponse {
    clientDataJSON: string;
    attestationObject: string;
    transports?: string[];
}

/**
 * generated from [PasskeyAssertionResponse](file://./../../../../apps/api/data/contracts/passkey.types.ck#L63)
 */
export interface PasskeyAssertionResponse {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle?: string;
}

/**
 * What `navigator.credentials.create` is called with, to make a passkey.
 * generated from [PasskeyCreationOptions](file://./../../../../apps/api/data/contracts/passkey.types.ck#L29)
 */
export interface PasskeyCreationOptions {
    rp: PasskeyRelyingParty;
    user: PasskeyUser;
    challenge: string;
    pubKeyCredParams: PasskeyKeyParam[];
    timeout?: number;
    attestation: string;
}

/**
 * What `navigator.credentials.get` is called with, to prove one.
 * generated from [PasskeyRequestOptions](file://./../../../../apps/api/data/contracts/passkey.types.ck#L39)
 */
export interface PasskeyRequestOptions {
    challenge: string;
    timeout?: number;
    rpId?: string;
    userVerification?: string;
    allowCredentials?: PasskeyCredentialDescriptor[];
}

/**
 * generated from [PasskeyExtensionResults](file://./../../../../apps/api/data/contracts/passkey.types.ck#L51)
 */
export interface PasskeyExtensionResults {
    appid?: boolean;
    appidExclude?: boolean;
    credProps?: PasskeyCredProps;
}

/**
 * A new passkey, as the browser made it.
 * generated from [PasskeyAttestationCredential](file://./../../../../apps/api/data/contracts/passkey.types.ck#L71)
 */
export interface PasskeyAttestationCredential {
    id: string;
    type: string;
    rawId: string;
    authenticatorAttachment?: string;
    clientExtensionResults: PasskeyExtensionResults;
    response: PasskeyAttestationResponse;
}

/**
 * A passkey proving itself against a challenge.
 * generated from [PasskeyAssertionCredential](file://./../../../../apps/api/data/contracts/passkey.types.ck#L81)
 */
export interface PasskeyAssertionCredential {
    id: string;
    type: string;
    rawId: string;
    authenticatorAttachment?: string;
    clientExtensionResults: PasskeyExtensionResults;
    response: PasskeyAssertionResponse;
}
