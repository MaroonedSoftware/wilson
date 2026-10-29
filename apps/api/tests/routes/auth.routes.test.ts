import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Container } from 'injectkit';
import { Kysely } from 'kysely';
import { ServerKitServerBuilder, type ServerKitRouterType } from '@maroonedsoftware/koa';
import { ConsoleLogger } from '@maroonedsoftware/logger';
import type { DB } from '#modules/data/db.js';
import { modules } from '#modules/modules.js';
import { routers } from '#src/routes/routes.setup.js';
import { setupMiddleware } from '#src/server/setup.middleware.js';
import { clearAccounts, holdAccounts } from '#tests/support/test.accounts.js';
import { buildTestServerConfig } from '#tests/support/test.config.js';

/**
 * Signing in over real HTTP: the app's own container, middleware and routers, against the test
 * database. `listen` is reached through a subclass because `start` would also run every module's
 * `start` hook, the job runner's among them, which has no business running in a test.
 */
class ListeningBuilder extends ServerKitServerBuilder {
    serve(signal: AbortSignal): Promise<Server> {
        return this.listen(0, signal);
    }
}

const STRONG_PASSWORD = 'correct horse battery staple 47';

let container: Container;
let db: Kysely<DB>;
let base: string;
let release: () => Promise<void>;
const stop = new AbortController();

beforeAll(async () => {
    release = await holdAccounts();
    const builder = new ListeningBuilder();
    container = await builder.setup(await buildTestServerConfig(), new ConsoleLogger(), modules);
    db = container.get(Kysely<DB>);
    builder.setupMiddleware(setupMiddleware).setupRoutes(routers(stop.signal) as ServerKitRouterType[]);
    const server = await builder.serve(stop.signal);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
    stop.abort();
    await clearAccounts(db);
    await db.destroy();
    await release();
});
beforeEach(async () => {
    await clearAccounts(db);
});

const call = (method: string, path: string, options: { body?: unknown; token?: string } = {}) =>
    fetch(`${base}${path}`, {
        method,
        headers: {
            ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
            ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

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
        expect(await (await call('GET', '/api/onboarding')).json()).toEqual({ accountExists: false });

        const created = await onboard();

        expect(created.status).toBe(201);
        expect(await created.json()).toEqual({ accountExists: true });
        expect(await (await call('GET', '/api/onboarding')).json()).toEqual({ accountExists: true });
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

        await clearAccounts(db);

        expect((await call('GET', '/api/auth/session', { token: accessToken })).status).toBe(401);
    });
});

/** Rollout step 3 enforces nothing: every other route answers a caller with no token, or a bad one. */
describe('nothing is enforced yet', () => {
    it('serves an ungated route with no token, and with a bad one', async () => {
        expect((await call('GET', '/api/health')).status).toBe(200);
        expect((await call('GET', '/api/health', { token: 'garbage' })).status).toBe(200);
    });
});
