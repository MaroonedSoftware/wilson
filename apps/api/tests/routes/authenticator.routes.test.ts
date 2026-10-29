import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { OtpProvider } from '@maroonedsoftware/authentication';
import { clearAccounts, holdAccounts } from '#tests/support/test.accounts.js';
import { onboardAndSignIn, request, startTestServer, STRONG_PASSWORD, type TestServer } from '#tests/support/test.server.js';

/**
 * An authenticator app as a second factor, over real HTTP: enrolment, the two-step sign-in, replay,
 * and what it does to step-up. Codes come from the library's own `OtpProvider`, as an app would
 * compute them from the seed it scanned.
 */
let server: TestServer;
let release: () => Promise<void>;
let passwordSession: string;

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
    ({ accessToken: passwordSession } = await onboardAndSignIn(server));
});

const otp = new OtpProvider();

/** The code an app shows for `secret`, `stepsAhead` 30-second steps from now. */
const codeFor = (secret: string, stepsAhead = 0): string =>
    otp.generate(secret, {
        type: 'totp',
        algorithm: 'sha1',
        tokenLength: 6,
        periodSeconds: 30,
        timestamp: DateTime.utc().plus({ seconds: 30 * stepsAhead }),
    });

/** Enrol an authenticator with the password session, returning its seed and id. */
const enrol = async (): Promise<{ secret: string; id: string }> => {
    const started = await request(server, 'POST', '/api/auth/factors/authenticator', { token: passwordSession, body: { label: 'phone' } });
    expect(started.status).toBe(200);
    const registration = (await started.json()) as { registrationId: string; uri: string; qrCode: string; secret: string };
    expect(registration.uri).toMatch(/^otpauth:\/\/totp\//);
    expect(registration.qrCode).toMatch(/^data:image\/png;base64,/);

    const verified = await request(server, 'POST', '/api/auth/factors/authenticator/verify', {
        token: passwordSession,
        body: { registrationId: registration.registrationId, code: codeFor(registration.secret) },
    });
    expect(verified.status).toBe(201);
    return { secret: registration.secret, id: ((await verified.json()) as { id: string }).id };
};

const passwordGrant = () =>
    request(server, 'POST', '/api/auth/token', { body: { grant_type: 'password', username: 'operator', password: STRONG_PASSWORD } });

const codeGrant = (challengeId: string, code: string) =>
    request(server, 'POST', '/api/auth/token', { body: { grant_type: 'authenticator', challenge_id: challengeId, code } });

/** Sign in with the password and then a code, returning the session's access token. */
const signInWithCode = async (secret: string): Promise<string> => {
    const { challengeId } = (await (await passwordGrant()).json()) as { challengeId: string };
    const res = await codeGrant(challengeId, codeFor(secret, 1));
    expect(res.status).toBe(200);
    return ((await res.json()) as { accessToken: string }).accessToken;
};

describe('enrolling an authenticator app', () => {
    it('lists it once a code from the app checks out', async () => {
        const { id } = await enrol();

        const res = await request(server, 'GET', '/api/auth/factors', { token: passwordSession });

        expect(await res.json()).toEqual([expect.objectContaining({ id, method: 'authenticator', label: 'phone' })]);
    });

    it('stores the seed encrypted, never as the app shows it', async () => {
        const { secret } = await enrol();

        const row = await server.db.selectFrom('runner.accountAuthenticators').select('secret').executeTakeFirstOrThrow();
        expect(row.secret).not.toContain(secret);
    });

    it('refuses a wrong code and enrols nothing', async () => {
        const started = await request(server, 'POST', '/api/auth/factors/authenticator', { token: passwordSession, body: {} });
        const { registrationId } = (await started.json()) as { registrationId: string };

        const res = await request(server, 'POST', '/api/auth/factors/authenticator/verify', {
            token: passwordSession,
            body: { registrationId, code: '000000' },
        });

        expect(res.status).toBe(401);
        expect(await (await request(server, 'GET', '/api/auth/factors', { token: passwordSession })).json()).toEqual([]);
    });
});

describe('signing in with an authenticator enrolled', () => {
    it('answers a correct password with mfa_required and no tokens', async () => {
        const { id } = await enrol();

        const body = (await (await passwordGrant()).json()) as Record<string, unknown>;

        expect(body).toMatchObject({ result: 'mfa_required', factors: [{ method: 'authenticator', id }] });
        expect(body.challengeId).toBeTruthy();
        expect(body).not.toHaveProperty('accessToken');
    });

    it('completes with a code from the app, and the session works', async () => {
        const { secret } = await enrol();

        const accessToken = await signInWithCode(secret);

        expect((await request(server, 'GET', '/api/auth/session', { token: accessToken })).status).toBe(200);
    });

    it('refuses a wrong code with 401, and the challenge still takes the right one', async () => {
        const { secret } = await enrol();
        const { challengeId } = (await (await passwordGrant()).json()) as { challengeId: string };

        expect((await codeGrant(challengeId, '000000')).status).toBe(401);
        expect((await codeGrant(challengeId, codeFor(secret, 1))).status).toBe(200);
    });

    it('completes a challenge once', async () => {
        const { secret } = await enrol();
        const { challengeId } = (await (await passwordGrant()).json()) as { challengeId: string };
        await codeGrant(challengeId, codeFor(secret, 1));

        expect((await codeGrant(challengeId, codeFor(secret, 1))).status).toBe(401);
    });

    it('refuses a code that has already been used, even on a new challenge', async () => {
        const { secret } = await enrol();
        await signInWithCode(secret);
        const { challengeId } = (await (await passwordGrant()).json()) as { challengeId: string };

        expect((await codeGrant(challengeId, codeFor(secret, 1))).status).toBe(401);
    });
});

describe('step-up with an authenticator enrolled', () => {
    it('no longer accepts a recent password on its own', async () => {
        await enrol();

        const res = await request(server, 'POST', '/api/auth/keys', { token: passwordSession, body: { name: 'k', scope: 'view' } });

        expect(res.status).toBe(403);
        expect(((await res.json()) as { details: { kind: string } }).details.kind).toBe('step_up_required');
    });

    it('accepts a session that proved the code', async () => {
        const { secret } = await enrol();
        const accessToken = await signInWithCode(secret);

        expect((await request(server, 'POST', '/api/auth/keys', { token: accessToken, body: { name: 'k', scope: 'view' } })).status).toBe(201);
    });

    it('lets that session remove the authenticator, after which a password alone signs in again', async () => {
        const { secret, id } = await enrol();
        const accessToken = await signInWithCode(secret);

        expect((await request(server, 'DELETE', `/api/auth/factors/${id}`, { token: accessToken })).status).toBe(204);

        expect(((await (await passwordGrant()).json()) as { result: string }).result).toBe('token');
    });

    it('refuses removal by a password-only session', async () => {
        const { id } = await enrol();

        expect((await request(server, 'DELETE', `/api/auth/factors/${id}`, { token: passwordSession })).status).toBe(403);
    });
});
