import { z } from 'zod';

/**
 * generated from [PasskeyRelyingParty](../../data/contracts/passkey.types.ck)
 */
export const PasskeyRelyingParty = z.strictObject({
    id: z.string(),
    name: z.string(),
});
export type PasskeyRelyingParty = z.infer<typeof PasskeyRelyingParty>;

/**
 * generated from [PasskeyUser](../../data/contracts/passkey.types.ck)
 */
export const PasskeyUser = z.strictObject({
    id: z.string(),
    name: z.string(),
    displayName: z.string(),
});
export type PasskeyUser = z.infer<typeof PasskeyUser>;

/**
 * generated from [PasskeyKeyParam](../../data/contracts/passkey.types.ck)
 */
export const PasskeyKeyParam = z.strictObject({
    type: z.string(),
    alg: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number()),
});
export type PasskeyKeyParam = z.infer<typeof PasskeyKeyParam>;

/**
 * generated from [PasskeyCredentialDescriptor](../../data/contracts/passkey.types.ck)
 */
export const PasskeyCredentialDescriptor = z.strictObject({
    type: z.string(),
    id: z.string(),
    transports: z.array(z.string()).optional(),
});
export type PasskeyCredentialDescriptor = z.infer<typeof PasskeyCredentialDescriptor>;

/**
 * generated from [PasskeyCredProps](../../data/contracts/passkey.types.ck)
 */
export const PasskeyCredProps = z.strictObject({
    rk: z.preprocess(v => (v === 'true' ? true : v === 'false' ? false : v), z.boolean()),
});
export type PasskeyCredProps = z.infer<typeof PasskeyCredProps>;

/**
 * generated from [PasskeyAttestationResponse](../../data/contracts/passkey.types.ck)
 */
export const PasskeyAttestationResponse = z.strictObject({
    clientDataJSON: z.string(),
    attestationObject: z.string(),
    transports: z.array(z.string()).optional(),
});
export type PasskeyAttestationResponse = z.infer<typeof PasskeyAttestationResponse>;

/**
 * generated from [PasskeyAssertionResponse](../../data/contracts/passkey.types.ck)
 */
export const PasskeyAssertionResponse = z.strictObject({
    clientDataJSON: z.string(),
    authenticatorData: z.string(),
    signature: z.string(),
    userHandle: z.string().optional(),
});
export type PasskeyAssertionResponse = z.infer<typeof PasskeyAssertionResponse>;

/**
 * What `navigator.credentials.create` is called with, to make a passkey.
 * generated from [PasskeyCreationOptions](../../data/contracts/passkey.types.ck)
 */
export const PasskeyCreationOptions = z.strictObject({
    rp: PasskeyRelyingParty,
    user: PasskeyUser,
    challenge: z.string(),
    pubKeyCredParams: z.array(PasskeyKeyParam),
    timeout: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number()).optional(),
    attestation: z.string(),
});
export type PasskeyCreationOptions = z.infer<typeof PasskeyCreationOptions>;

/**
 * What `navigator.credentials.get` is called with, to prove one.
 * generated from [PasskeyRequestOptions](../../data/contracts/passkey.types.ck)
 */
export const PasskeyRequestOptions = z.strictObject({
    challenge: z.string(),
    timeout: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number()).optional(),
    rpId: z.string().optional(),
    userVerification: z.string().optional(),
    allowCredentials: z.array(PasskeyCredentialDescriptor).optional(),
});
export type PasskeyRequestOptions = z.infer<typeof PasskeyRequestOptions>;

/**
 * generated from [PasskeyExtensionResults](../../data/contracts/passkey.types.ck)
 */
export const PasskeyExtensionResults = z.strictObject({
    appid: z.preprocess(v => (v === 'true' ? true : v === 'false' ? false : v), z.boolean()).optional(),
    appidExclude: z.preprocess(v => (v === 'true' ? true : v === 'false' ? false : v), z.boolean()).optional(),
    credProps: PasskeyCredProps.optional(),
});
export type PasskeyExtensionResults = z.infer<typeof PasskeyExtensionResults>;

/**
 * A new passkey, as the browser made it.
 * generated from [PasskeyAttestationCredential](../../data/contracts/passkey.types.ck)
 */
export const PasskeyAttestationCredential = z.strictObject({
    id: z.string(),
    type: z.string(),
    rawId: z.string(),
    authenticatorAttachment: z.string().optional(),
    clientExtensionResults: PasskeyExtensionResults,
    response: PasskeyAttestationResponse,
});
export type PasskeyAttestationCredential = z.infer<typeof PasskeyAttestationCredential>;

/**
 * A passkey proving itself against a challenge.
 * generated from [PasskeyAssertionCredential](../../data/contracts/passkey.types.ck)
 */
export const PasskeyAssertionCredential = z.strictObject({
    id: z.string(),
    type: z.string(),
    rawId: z.string(),
    authenticatorAttachment: z.string().optional(),
    clientExtensionResults: PasskeyExtensionResults,
    response: PasskeyAssertionResponse,
});
export type PasskeyAssertionCredential = z.infer<typeof PasskeyAssertionCredential>;
