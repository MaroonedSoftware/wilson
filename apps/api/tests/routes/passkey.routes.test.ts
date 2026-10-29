import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AccountRepository } from '#modules/authentication/account.repository.js';
import { clearAccounts, holdAccounts } from '#tests/support/test.accounts.js';
import { onboardAndSignIn, request, startTestServer, STRONG_PASSWORD, type TestServer } from '#tests/support/test.server.js';

/**
 * Passkeys over real HTTP. A real attestation or assertion needs an authenticator, so this covers
 * what the server decides on its own: which origins a passkey can be made or used at, that an
 * enrolled passkey turns a password into a challenge, and that a bad answer is refused without
 * spending the sign-in. The signature checks themselves are the authentication library's.
 */
const WEB = { origin: 'http://localhost:13101' };

let server: TestServer;
let release: () => Promise<void>;
let session: string;

beforeAll(async () => {
    release = await holdAccounts();
    server = await startTestServer();
});
afterAll(async () => {
    await clearAccounts(server.db);
    await server.stop();
    await release();
});
beforeEach(async () => {
    await clearAccounts(server.db);
    ({ accessToken: session } = await onboardAndSignIn(server));
});

/** A passkey row as enrolment would leave it, for the sign-in tests. */
const enrolPasskeyDirectly = async (): Promise<string> => {
    const account = await server.container.get(AccountRepository).findByUsername('operator');
    const row = await server.db
        .insertInto('runner.accountPasskeys')
        .values({ accountId: account!.id, publicKey: 'test-public-key', publicKeyId: 'Y3JlZGVudGlhbC1pZA', counter: 0, label: 'laptop' })
        .returning('id')
        .executeTakeFirstOrThrow();
    return row.id;
};

const passwordGrant = () =>
    request(server, 'POST', '/api/auth/token', { body: { grant_type: 'password', username: 'operator', password: STRONG_PASSWORD } });

describe('enrolling a passkey', () => {
    it('issues creation options bound to the web app origin', async () => {
        const res = await request(server, 'POST', '/api/auth/factors/passkey', { token: session, body: { label: 'laptop' }, headers: WEB });

        expect(res.status).toBe(200);
        const { registrationId, options } = (await res.json()) as {
            registrationId: string;
            options: { rp: { id: string }; user: { name: string }; challenge: string };
        };
        expect(registrationId).toBeTruthy();
        expect(options.rp.id).toBe('localhost');
        expect(options.user.name).toBe('operator');
        expect(options.challenge.length).toBeGreaterThan(16);
    });

    it('refuses an origin that is not the web app', async () => {
        const res = await request(server, 'POST', '/api/auth/factors/passkey', {
            token: session,
            body: {},
            headers: { origin: 'https://elsewhere.example' },
        });

        expect(res.status).toBe(400);
    });

    it('refuses a request with no origin, as the CLI makes', async () => {
        expect((await request(server, 'POST', '/api/auth/factors/passkey', { token: session, body: {} })).status).toBe(400);
    });

    it('refuses an answer that does not check out, without enrolling anything', async () => {
        const started = await request(server, 'POST', '/api/auth/factors/passkey', { token: session, body: {}, headers: WEB });
        const { registrationId } = (await started.json()) as { registrationId: string };
        const credential = {
            id: 'x',
            type: 'public-key',
            rawId: 'x',
            clientExtensionResults: {},
            response: { clientDataJSON: 'e30', attestationObject: 'AA' },
        };

        const res = await request(server, 'POST', '/api/auth/factors/passkey/verify', {
            token: session,
            body: { registrationId, credential },
            headers: WEB,
        });

        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
        expect(await (await request(server, 'GET', '/api/auth/factors', { token: session })).json()).toEqual([]);
    });
});

describe('signing in with a passkey enrolled', () => {
    it('answers the password with mfa_required, listing the passkey', async () => {
        const id = await enrolPasskeyDirectly();

        const body = (await (await passwordGrant()).json()) as { result: string; factors: unknown[] };

        expect(body.result).toBe('mfa_required');
        expect(body.factors).toEqual([{ method: 'passkey', id, label: 'laptop' }]);
    });

    it('issues a passkey challenge for that sign-in, naming the enrolled credential', async () => {
        await enrolPasskeyDirectly();
        const { challengeId } = (await (await passwordGrant()).json()) as { challengeId: string };

        const res = await request(server, 'POST', '/api/auth/passkey/challenge', { body: { challenge_id: challengeId }, headers: WEB });

        expect(res.status).toBe(200);
        const { passkeyChallengeId, options } = (await res.json()) as { passkeyChallengeId: string; options: { allowCredentials: { id: string }[] } };
        expect(passkeyChallengeId).toBeTruthy();
        expect(options.allowCredentials.map(credential => credential.id)).toContain('Y3JlZGVudGlhbC1pZA');
    });

    it('refuses a passkey challenge for a sign-in that was never started', async () => {
        expect((await request(server, 'POST', '/api/auth/passkey/challenge', { body: { challenge_id: 'nope' }, headers: WEB })).status).toBe(401);
    });

    it('refuses a bad assertion, and the sign-in can still be completed', async () => {
        await enrolPasskeyDirectly();
        const { challengeId } = (await (await passwordGrant()).json()) as { challengeId: string };
        const started = await request(server, 'POST', '/api/auth/passkey/challenge', { body: { challenge_id: challengeId }, headers: WEB });
        const { passkeyChallengeId } = (await started.json()) as { passkeyChallengeId: string };
        const credential = {
            id: 'Y3JlZGVudGlhbC1pZA',
            type: 'public-key',
            rawId: 'Y3JlZGVudGlhbC1pZA',
            clientExtensionResults: {},
            response: { clientDataJSON: 'e30', authenticatorData: 'AA', signature: 'AA' },
        };

        const res = await request(server, 'POST', '/api/auth/token', {
            body: { grant_type: 'passkey', challenge_id: challengeId, passkey_challenge_id: passkeyChallengeId, credential },
            headers: WEB,
        });

        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
        expect((await request(server, 'POST', '/api/auth/passkey/challenge', { body: { challenge_id: challengeId }, headers: WEB })).status).toBe(
            200,
        );
    });

    it('counts a passkey as a strong factor for step-up', async () => {
        await enrolPasskeyDirectly();

        const res = await request(server, 'POST', '/api/auth/keys', { token: session, body: { name: 'k', scope: 'view' } });

        expect(res.status).toBe(403);
    });
});
