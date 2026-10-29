// @vitest-environment jsdom
//
// The passkey half of signing in (`lib/webauthn.ts`, `completeSignInWithPasskey`), against a
// stubbed `navigator.credentials`: jsdom has no WebAuthn, and what matters here is that binary
// fields cross as base64url in both directions and the grant names both challenges.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { completeSignInWithPasskey } from '#src/lib/auth.js';
import { API_BASE } from '#src/lib/sdk.js';
import { currentAccessToken, setAccessToken } from '#src/lib/session.js';
import { assertPasskey, passkeysAvailable } from '#src/lib/webauthn.js';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const bytes = (...values: number[]) => new Uint8Array(values).buffer;

/** What a browser hands back from `navigator.credentials.get`. */
const assertion = () => ({
    id: 'cred-id',
    rawId: bytes(1, 2, 3),
    type: 'public-key',
    authenticatorAttachment: 'platform',
    getClientExtensionResults: () => ({ credProps: { rk: true }, somethingElse: 1 }),
    response: { clientDataJSON: bytes(123, 125), authenticatorData: bytes(0), signature: bytes(255, 254), userHandle: null },
});

let fetchMock: ReturnType<typeof vi.fn>;
let get: ReturnType<typeof vi.fn>;

beforeEach(() => {
    setAccessToken(undefined);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    get = vi.fn(async () => assertion());
    vi.stubGlobal('navigator', { ...navigator, credentials: { get, create: vi.fn() } });
    vi.stubGlobal('PublicKeyCredential', function PublicKeyCredential() {});
});
afterEach(() => {
    vi.unstubAllGlobals();
});

describe('passkeysAvailable', () => {
    it('needs a secure context and WebAuthn', () => {
        vi.stubGlobal('isSecureContext', true);
        expect(passkeysAvailable()).toBe(true);
        vi.stubGlobal('isSecureContext', false);
        expect(passkeysAvailable()).toBe(false);
    });
});

describe('assertPasskey', () => {
    it('decodes the challenge and credential ids from base64url, and encodes the answer back', async () => {
        const credential = await assertPasskey({ challenge: 'AQID', rpId: 'localhost', allowCredentials: [{ type: 'public-key', id: '_-8' }] });

        const publicKey = get.mock.calls[0]![0].publicKey;
        expect([...new Uint8Array(publicKey.challenge)]).toEqual([1, 2, 3]);
        expect([...new Uint8Array(publicKey.allowCredentials[0].id)]).toEqual([255, 239]);
        expect(credential).toEqual({
            id: 'cred-id',
            type: 'public-key',
            rawId: 'AQID',
            authenticatorAttachment: 'platform',
            // Only what the API's strict contract names.
            clientExtensionResults: { credProps: { rk: true } },
            response: { clientDataJSON: 'e30', authenticatorData: 'AA', signature: '__4' },
        });
    });
});

describe('completeSignInWithPasskey', () => {
    it('asks for a passkey challenge, has the browser sign it, and signs in with the answer', async () => {
        fetchMock
            .mockResolvedValueOnce(json(200, { passkeyChallengeId: 'pk-1', options: { challenge: 'AQID' } }))
            .mockResolvedValueOnce(json(200, { result: 'token', accessToken: 'with-passkey', expiresIn: 1, tokenType: 'Bearer' }));

        await completeSignInWithPasskey({ challengeId: 'ch-1', passkey: true });

        const [challengeUrl, challengeInit] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(challengeUrl).toBe(`${API_BASE}/api/auth/passkey/challenge`);
        expect(JSON.parse(challengeInit.body as string)).toEqual({ challenge_id: 'ch-1' });
        const grant = JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string);
        expect(grant).toMatchObject({ grant_type: 'passkey', challenge_id: 'ch-1', passkey_challenge_id: 'pk-1', credential: { rawId: 'AQID' } });
        expect(currentAccessToken()).toBe('with-passkey');
    });
});
