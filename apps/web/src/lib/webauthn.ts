import type {
    PasskeyAssertionCredential,
    PasskeyAttestationCredential,
    PasskeyCreationOptions,
    PasskeyExtensionResults,
    PasskeyRequestOptions,
} from '@wilson/sdk';

/**
 * The browser half of a passkey, after deadair's: turning the API's options into
 * `navigator.credentials` calls and the browser's answer back into JSON.
 *
 * WebAuthn speaks `ArrayBuffer` and the API speaks base64url, so every binary field crosses here in
 * one direction or the other. Nothing else in the app touches `navigator.credentials`.
 */

/**
 * Whether this browser can use a passkey here at all. WebAuthn needs a secure context: `https://`,
 * or `localhost`. Over plain `http://` on another address the browser refuses before the API is
 * asked, so the app offers no passkey there rather than a button that can only fail.
 */
export function passkeysAvailable(): boolean {
    return typeof window !== 'undefined' && window.isSecureContext && typeof window.PublicKeyCredential === 'function';
}

/** The browser reports a closed prompt and a timed-out one alike as NotAllowedError: a choice, not a fault. */
export function isPasskeyCancelled(error: unknown): boolean {
    return error instanceof DOMException && error.name === 'NotAllowedError';
}

function base64UrlToBuffer(value: string): ArrayBuffer {
    const padded = value
        .replaceAll('-', '+')
        .replaceAll('_', '/')
        .padEnd(value.length + ((4 - (value.length % 4)) % 4), '=');
    const binary = atob(padded);
    const buffer = new ArrayBuffer(binary.length);
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return buffer;
}

function bufferToBase64Url(buffer: ArrayBuffer): string {
    let binary = '';
    for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** Only the extension results the API's contract names: it is strict, and refuses anything else. */
function extensionResults(credential: PublicKeyCredential): PasskeyExtensionResults {
    const results = credential.getClientExtensionResults() as { appid?: boolean; appidExclude?: boolean; credProps?: { rk?: boolean } };
    return {
        ...(results.appid === undefined ? {} : { appid: results.appid }),
        ...(results.appidExclude === undefined ? {} : { appidExclude: results.appidExclude }),
        ...(results.credProps?.rk === undefined ? {} : { credProps: { rk: results.credProps.rk } }),
    };
}

const attachment = (credential: PublicKeyCredential) =>
    credential.authenticatorAttachment ? { authenticatorAttachment: credential.authenticatorAttachment } : {};

/** Make a passkey for the registration the API started. */
export async function createPasskey(options: PasskeyCreationOptions): Promise<PasskeyAttestationCredential> {
    const credential = (await navigator.credentials.create({
        publicKey: {
            rp: { id: options.rp.id, name: options.rp.name },
            user: { id: base64UrlToBuffer(options.user.id), name: options.user.name, displayName: options.user.displayName },
            challenge: base64UrlToBuffer(options.challenge),
            pubKeyCredParams: options.pubKeyCredParams.map(param => ({ type: 'public-key' as const, alg: param.alg })),
            ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
            attestation: options.attestation as AttestationConveyancePreference,
        },
    })) as PublicKeyCredential | null;
    if (!credential) throw new DOMException('Passkey prompt closed', 'NotAllowedError');
    const response = credential.response as AuthenticatorAttestationResponse;
    const transports = typeof response.getTransports === 'function' ? response.getTransports() : undefined;

    return {
        id: credential.id,
        type: 'public-key',
        rawId: bufferToBase64Url(credential.rawId),
        ...attachment(credential),
        clientExtensionResults: extensionResults(credential),
        response: {
            clientDataJSON: bufferToBase64Url(response.clientDataJSON),
            attestationObject: bufferToBase64Url(response.attestationObject),
            ...(transports ? { transports } : {}),
        },
    };
}

/** Prove a passkey the API already knows, for the challenge it issued. */
export async function assertPasskey(options: PasskeyRequestOptions): Promise<PasskeyAssertionCredential> {
    const credential = (await navigator.credentials.get({
        publicKey: {
            challenge: base64UrlToBuffer(options.challenge),
            ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
            ...(options.rpId === undefined ? {} : { rpId: options.rpId }),
            ...(options.userVerification === undefined ? {} : { userVerification: options.userVerification as UserVerificationRequirement }),
            ...(options.allowCredentials
                ? {
                      allowCredentials: options.allowCredentials.map(allowed => ({
                          type: 'public-key' as const,
                          id: base64UrlToBuffer(allowed.id),
                          ...(allowed.transports ? { transports: allowed.transports as AuthenticatorTransport[] } : {}),
                      })),
                  }
                : {}),
        },
    })) as PublicKeyCredential | null;
    if (!credential) throw new DOMException('Passkey prompt closed', 'NotAllowedError');
    const response = credential.response as AuthenticatorAssertionResponse;

    return {
        id: credential.id,
        type: 'public-key',
        rawId: bufferToBase64Url(credential.rawId),
        ...attachment(credential),
        clientExtensionResults: extensionResults(credential),
        response: {
            clientDataJSON: bufferToBase64Url(response.clientDataJSON),
            authenticatorData: bufferToBase64Url(response.authenticatorData),
            signature: bufferToBase64Url(response.signature),
            ...(response.userHandle ? { userHandle: bufferToBase64Url(response.userHandle) } : {}),
        },
    };
}
