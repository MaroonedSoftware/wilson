# WebAuthn, as the API and the browser exchange it (PROJECT.md, Authentication: Factors). Every
# binary field is base64url: WebAuthn speaks ArrayBuffer and JSON cannot, so the web app converts at
# the edge (`apps/web/src/lib/webauthn.ts`). These carry exactly the fields the authentication
# library reads and no more, and they are strict, so the web app sends only these.

contract PasskeyRelyingParty: {
    id: string
    name: string
}

contract PasskeyUser: {
    id: string
    name: string
    displayName: string
}

contract PasskeyKeyParam: {
    type: string
    alg: number
}

contract PasskeyCredentialDescriptor: {
    type: string
    id: string
    transports?: array(string)
}

# What `navigator.credentials.create` is called with, to make a passkey.
contract PasskeyCreationOptions: {
    rp: PasskeyRelyingParty
    user: PasskeyUser
    challenge: string
    pubKeyCredParams: array(PasskeyKeyParam)
    timeout?: number
    attestation: string
}

# What `navigator.credentials.get` is called with, to prove one.
contract PasskeyRequestOptions: {
    challenge: string
    timeout?: number
    rpId?: string
    userVerification?: string
    allowCredentials?: array(PasskeyCredentialDescriptor)
}

contract PasskeyCredProps: {
    rk: boolean
}

contract PasskeyExtensionResults: {
    appid?: boolean
    appidExclude?: boolean
    credProps?: PasskeyCredProps
}

contract PasskeyAttestationResponse: {
    clientDataJSON: string
    attestationObject: string
    transports?: array(string)
}

contract PasskeyAssertionResponse: {
    clientDataJSON: string
    authenticatorData: string
    signature: string
    userHandle?: string
}

# A new passkey, as the browser made it.
contract PasskeyAttestationCredential: {
    id: string
    type: string
    rawId: string
    authenticatorAttachment?: string
    clientExtensionResults: PasskeyExtensionResults
    response: PasskeyAttestationResponse
}

# A passkey proving itself against a challenge.
contract PasskeyAssertionCredential: {
    id: string
    type: string
    rawId: string
    authenticatorAttachment?: string
    clientExtensionResults: PasskeyExtensionResults
    response: PasskeyAssertionResponse
}
