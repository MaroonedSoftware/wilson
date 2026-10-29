/**
 * generated from [PasskeyRelyingParty](../../../../apps/api/data/contracts/passkey.types.ck)
 */
export interface PasskeyRelyingParty {
    id: string;
    name: string;
}

/**
 * generated from [PasskeyUser](../../../../apps/api/data/contracts/passkey.types.ck)
 */
export interface PasskeyUser {
    id: string;
    name: string;
    displayName: string;
}

/**
 * generated from [PasskeyKeyParam](../../../../apps/api/data/contracts/passkey.types.ck)
 */
export interface PasskeyKeyParam {
    type: string;
    alg: number;
}

/**
 * generated from [PasskeyCredentialDescriptor](../../../../apps/api/data/contracts/passkey.types.ck)
 */
export interface PasskeyCredentialDescriptor {
    type: string;
    id: string;
    transports?: string[];
}

/**
 * generated from [PasskeyCredProps](../../../../apps/api/data/contracts/passkey.types.ck)
 */
export interface PasskeyCredProps {
    rk: boolean;
}

/**
 * generated from [PasskeyAttestationResponse](../../../../apps/api/data/contracts/passkey.types.ck)
 */
export interface PasskeyAttestationResponse {
    clientDataJSON: string;
    attestationObject: string;
    transports?: string[];
}

/**
 * generated from [PasskeyAssertionResponse](../../../../apps/api/data/contracts/passkey.types.ck)
 */
export interface PasskeyAssertionResponse {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle?: string;
}

/**
 * What `navigator.credentials.create` is called with, to make a passkey.
 * generated from [PasskeyCreationOptions](../../../../apps/api/data/contracts/passkey.types.ck)
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
 * generated from [PasskeyRequestOptions](../../../../apps/api/data/contracts/passkey.types.ck)
 */
export interface PasskeyRequestOptions {
    challenge: string;
    timeout?: number;
    rpId?: string;
    userVerification?: string;
    allowCredentials?: PasskeyCredentialDescriptor[];
}

/**
 * generated from [PasskeyExtensionResults](../../../../apps/api/data/contracts/passkey.types.ck)
 */
export interface PasskeyExtensionResults {
    appid?: boolean;
    appidExclude?: boolean;
    credProps?: PasskeyCredProps;
}

/**
 * A new passkey, as the browser made it.
 * generated from [PasskeyAttestationCredential](../../../../apps/api/data/contracts/passkey.types.ck)
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
 * generated from [PasskeyAssertionCredential](../../../../apps/api/data/contracts/passkey.types.ck)
 */
export interface PasskeyAssertionCredential {
    id: string;
    type: string;
    rawId: string;
    authenticatorAttachment?: string;
    clientExtensionResults: PasskeyExtensionResults;
    response: PasskeyAssertionResponse;
}
