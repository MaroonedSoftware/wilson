import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearAccounts, holdAccounts } from '#tests/support/test.accounts.js';
import { request, startTestServer, STRONG_PASSWORD, type TestServer } from '#tests/support/test.server.js';

/** Signing in over real HTTP: the app's own container, middleware and routers (`startTestServer`). */
let server: TestServer;
let release: () => Promise<void>;

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
});

const call = (method: string, path: string, options: { body?: unknown; token?: string } = {}) => request(server, method, path, options);

const onboard = () => call('POST', '/api/onboarding', { body: { username: 'operator', password: STRONG_PASSWORD } });

const signIn = async (password = STRONG_PASSWORD) =>
    call('POST', '/api/auth/token', { body: { grant_type: 'password', username: 'operator', password } });

const tokens = async () => {
    const res = await signIn();
    expect(res.status).toBe(200);
    return (await res.json()) as { accessToken: string; refreshToken: string; expiresIn: number; tokenType: string };
};

describe('onboarding over HTTP', () => {
    it('reports no account, creates one with 201, then reports it', async () => {
        expect(await (await call('GET', '/api/onboarding')).json()).toEqual({ requirements: [expect.objectContaining({ key: 'account', optional: false })] });

        const created = await onboard();

        expect(created.status).toBe(201);
        expect(await created.json()).toEqual({ requirements: [] });
        expect(await (await call('GET', '/api/onboarding')).json()).toEqual({ requirements: [] });
    });

    it('answers a second onboarding with 409', async () => {
        await onboard();

        expect((await onboard()).status).toBe(409);
    });
});

describe('the password grant', () => {
    beforeEach(async () => {
        await onboard();
    });

    it('signs in, and the access token names the account', async () => {
        const { accessToken, refreshToken, expiresIn, tokenType } = await tokens();

        expect(refreshToken).toBeTruthy();
        expect(tokenType).toBe('Bearer');
        expect(expiresIn).toBeGreaterThan(29 * 24 * 60 * 60);
        const session = await call('GET', '/api/auth/session', { token: accessToken });
        expect(session.status).toBe(200);
        expect(await session.json()).toMatchObject({ username: 'operator' });
    });

    it('matches the username without regard to case', async () => {
        const res = await call('POST', '/api/auth/token', { body: { grant_type: 'password', username: 'OPERATOR', password: STRONG_PASSWORD } });

        expect(res.status).toBe(200);
    });

    it('refuses a wrong password with 401', async () => {
        expect((await signIn('not the password at all')).status).toBe(401);
    });

    it('refuses an unknown username with 401, the same as a wrong password', async () => {
        const res = await call('POST', '/api/auth/token', { body: { grant_type: 'password', username: 'nobody', password: STRONG_PASSWORD } });

        expect(res.status).toBe(401);
    });

    it('refuses a grant missing its fields with 400', async () => {
        expect((await call('POST', '/api/auth/token', { body: { grant_type: 'password', username: 'operator' } })).status).toBe(400);
    });

    it('answers 429 once five wrong passwords are spent', async () => {
        for (let i = 0; i < 5; i++) {
            expect((await signIn(`wrong password number ${i}`)).status).toBe(401);
        }

        expect((await signIn()).status).toBe(429);
    });
});

describe('the refresh_token grant', () => {
    beforeEach(async () => {
        await onboard();
    });

    const refresh = (refreshToken: string) => call('POST', '/api/auth/token', { body: { grant_type: 'refresh_token', refresh_token: refreshToken } });

    it('trades a refresh token for a new pair that works', async () => {
        const first = await tokens();

        const res = await refresh(first.refreshToken);

        expect(res.status).toBe(200);
        const second = (await res.json()) as { accessToken: string; refreshToken: string };
        expect(second.refreshToken).not.toBe(first.refreshToken);
        expect((await call('GET', '/api/auth/session', { token: second.accessToken })).status).toBe(200);
    });

    /** Single use, with replay detection: a spent refresh token is taken as stolen. */
    it('refuses a spent refresh token and revokes the session it belonged to', async () => {
        const first = await tokens();
        const second = (await (await refresh(first.refreshToken)).json()) as { accessToken: string };

        expect((await refresh(first.refreshToken)).status).toBe(401);
        expect((await call('GET', '/api/auth/session', { token: second.accessToken })).status).toBe(401);
    });

    it('refuses something that is not a refresh token with 401', async () => {
        expect((await refresh('not-a-token')).status).toBe(401);
    });
});

describe('the current session and sign-out', () => {
    beforeEach(async () => {
        await onboard();
    });

    it('answers 401 with no bearer token', async () => {
        expect((await call('GET', '/api/auth/session')).status).toBe(401);
    });

    it('answers 401, not 500, for a bearer token that is not one of ours', async () => {
        expect((await call('GET', '/api/auth/session', { token: 'garbage' })).status).toBe(401);
    });

    it('signs out with 204, after which the token no longer works', async () => {
        const { accessToken } = await tokens();

        expect((await call('POST', '/api/auth/logout', { token: accessToken })).status).toBe(204);
        expect((await call('GET', '/api/auth/session', { token: accessToken })).status).toBe(401);
    });

    it('signs out with 204 even with no session to end', async () => {
        expect((await call('POST', '/api/auth/logout')).status).toBe(204);
        expect((await call('POST', '/api/auth/logout', { token: 'garbage' })).status).toBe(204);
    });

    it('refuses a token whose account has gone', async () => {
        const { accessToken } = await tokens();

        await clearAccounts(server.db);

        expect((await call('GET', '/api/auth/session', { token: accessToken })).status).toBe(401);
    });
});

/** A public route answers with no token, and with a bad one: a dead token is not an error. */
describe('public routes', () => {
    it('serve a caller with no token, and with a bad one', async () => {
        expect((await call('GET', '/api/health')).status).toBe(200);
        expect((await call('GET', '/api/health', { token: 'garbage' })).status).toBe(200);
    });
});

/** The web app's cookie transport (`session.cookies.ts`), opted into with `x-wilson-cookies: 1`. */
describe('the web app cookies', () => {
    beforeEach(async () => {
        await onboard();
    });

    const OPT_IN = { 'x-wilson-cookies': '1' };

    const cookieSignIn = () =>
        request(server, 'POST', '/api/auth/token', {
            body: { grant_type: 'password', username: 'operator', password: STRONG_PASSWORD },
            headers: OPT_IN,
        });

    /** `name=value` for each Set-Cookie, ready to send back as a Cookie header. */
    const cookieJar = (res: Response): string =>
        res.headers
            .getSetCookie()
            .map(cookie => cookie.split(';')[0])
            .join('; ');

    it('keeps the refresh token out of the body and sets both cookies httpOnly and SameSite=Strict', async () => {
        const res = await cookieSignIn();

        expect(res.status).toBe(200);
        const body = (await res.json()) as Record<string, unknown>;
        expect(body.accessToken).toBeTruthy();
        expect(body).not.toHaveProperty('refreshToken');
        const cookies = res.headers.getSetCookie();
        const refresh = cookies.find(cookie => cookie.startsWith('wilson_rt='))!;
        const stream = cookies.find(cookie => cookie.startsWith('wilson_at='))!;
        expect(refresh).toMatch(/path=\/api\/auth/i);
        expect(refresh).toMatch(/httponly/i);
        expect(refresh).toMatch(/samesite=strict/i);
        expect(stream).toMatch(/path=\/api;/i);
        expect(stream).toMatch(/httponly/i);
    });

    it('still returns the refresh token in the body without the opt-in, as the CLI expects', async () => {
        const body = (await (await signIn()).json()) as Record<string, unknown>;

        expect(body.refreshToken).toBeTruthy();
    });

    it('refreshes from the cookie alone, rotating it', async () => {
        const first = await cookieSignIn();

        const res = await request(server, 'POST', '/api/auth/token', {
            body: { grant_type: 'refresh_token' },
            headers: { ...OPT_IN, cookie: cookieJar(first) },
        });

        expect(res.status).toBe(200);
        const { accessToken } = (await res.json()) as { accessToken: string };
        expect((await call('GET', '/api/auth/session', { token: accessToken })).status).toBe(200);
        expect(cookieJar(res)).not.toBe(cookieJar(first));
    });

    it('clears a refresh cookie that has been spent', async () => {
        const first = await cookieSignIn();
        const jar = cookieJar(first);
        await request(server, 'POST', '/api/auth/token', { body: { grant_type: 'refresh_token' }, headers: { ...OPT_IN, cookie: jar } });

        const replay = await request(server, 'POST', '/api/auth/token', {
            body: { grant_type: 'refresh_token' },
            headers: { ...OPT_IN, cookie: jar },
        });

        expect(replay.status).toBe(401);
        expect(replay.headers.getSetCookie().find(cookie => cookie.startsWith('wilson_rt='))).toMatch(/expires=Thu, 01 Jan 1970/i);
    });

    it('answers 400 for a refresh with neither a body token nor a cookie', async () => {
        expect((await request(server, 'POST', '/api/auth/token', { body: { grant_type: 'refresh_token' } })).status).toBe(400);
    });

    it('clears both cookies on sign-out', async () => {
        const res = await call('POST', '/api/auth/logout');

        const cleared = res.headers.getSetCookie();
        expect(cleared.find(cookie => cookie.startsWith('wilson_rt='))).toMatch(/expires=Thu, 01 Jan 1970/i);
        expect(cleared.find(cookie => cookie.startsWith('wilson_at='))).toMatch(/expires=Thu, 01 Jan 1970/i);
    });

    it('does not accept the stream cookie as a credential on any other route', async () => {
        const jar = cookieJar(await cookieSignIn());

        expect((await request(server, 'GET', '/api/auth/session', { headers: { cookie: jar } })).status).toBe(401);
    });
});

describe('CORS', () => {
    it('admits the web app origin with credentials', async () => {
        const res = await request(server, 'GET', '/api/health', { headers: { origin: 'http://localhost:13101' } });

        expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:13101');
        expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    });

    /** Anything else on this machine must not be able to redeem the refresh cookie and read the result. */
    it('admits no other origin, not even another localhost port', async () => {
        const res = await request(server, 'GET', '/api/health', { headers: { origin: 'http://localhost:9999' } });

        expect(res.headers.get('access-control-allow-origin')).toBeNull();
    });
});
