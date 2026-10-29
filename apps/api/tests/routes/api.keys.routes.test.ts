import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearAccounts, holdAccounts } from '#tests/support/test.accounts.js';
import { onboardAndSignIn, request, startTestServer, type TestServer } from '#tests/support/test.server.js';

/** API keys over real HTTP (`startTestServer`): minting, using, rotating and revoking. */
let server: TestServer;
let release: () => Promise<void>;
let accessToken: string;

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
    ({ accessToken } = await onboardAndSignIn(server));
});

const createKey = async (token: string, body: Record<string, unknown> = { name: 'cli', scope: 'manage' }) =>
    request(server, 'POST', '/api/auth/keys', { token, body });

const issued = async () => {
    const res = await createKey(accessToken);
    expect(res.status).toBe(201);
    return (await res.json()) as { key: { id: string; name: string; hint: string; scope: string }; token: string };
};

describe('API keys', () => {
    it('mints a wl_ token, shown once, that signs requests in as the account', async () => {
        const { key, token } = await issued();

        expect(token).toMatch(/^wl_/);
        expect(key).toMatchObject({ name: 'cli', scope: 'manage' });
        expect(token.endsWith(key.hint) || token.includes(key.hint)).toBe(true);
        const session = await request(server, 'GET', '/api/auth/session', { token });
        expect(session.status).toBe(200);
        expect(await session.json()).toMatchObject({ email: 'operator@example.com' });
    });

    it('stores only a hash of the token', async () => {
        const { token } = await issued();

        const rows = await server.db.selectFrom('runner.apiKeys').select(['secretHash', 'hint']).execute();
        expect(rows).toHaveLength(1);
        expect(rows[0]!.secretHash).not.toContain(token);
        expect(JSON.stringify(rows)).not.toContain(token);
    });

    it('lists keys without their tokens', async () => {
        const { token } = await issued();

        const res = await request(server, 'GET', '/api/auth/keys', { token: accessToken });

        expect(res.status).toBe(200);
        const body = await res.text();
        expect(JSON.parse(body)).toHaveLength(1);
        expect(body).not.toContain(token);
    });

    it('refuses to let a key mint another key, with 403', async () => {
        const { token } = await issued();

        expect((await createKey(token)).status).toBe(403);
    });

    it('refuses to let a key rotate a key, with 403', async () => {
        const { key, token } = await issued();

        expect((await request(server, 'POST', `/api/auth/keys/${key.id}/rotate`, { token })).status).toBe(403);
    });

    it('rotates a key: the new token works and the old one stops', async () => {
        const { key, token: old } = await issued();

        const res = await request(server, 'POST', `/api/auth/keys/${key.id}/rotate`, { token: accessToken });

        expect(res.status).toBe(200);
        const { token: rotated } = (await res.json()) as { token: string };
        expect(rotated).not.toBe(old);
        expect((await request(server, 'GET', '/api/auth/session', { token: rotated })).status).toBe(200);
        expect((await request(server, 'GET', '/api/auth/session', { token: old })).status).toBe(401);
    });

    it('revokes a key, after which it no longer signs anything in', async () => {
        const { key, token } = await issued();

        const res = await request(server, 'DELETE', `/api/auth/keys/${key.id}`, { token: accessToken });

        expect(res.status).toBe(200);
        expect(await res.json()).toHaveProperty('revokedAt');
        expect((await request(server, 'GET', '/api/auth/session', { token })).status).toBe(401);
    });

    it('lets a key revoke itself', async () => {
        const { key, token } = await issued();

        expect((await request(server, 'DELETE', `/api/auth/keys/${key.id}`, { token })).status).toBe(200);
        expect((await request(server, 'GET', '/api/auth/session', { token })).status).toBe(401);
    });

    it('answers 404 for a key id that does not exist', async () => {
        expect((await request(server, 'DELETE', '/api/auth/keys/00000000-0000-4000-8000-000000000000', { token: accessToken })).status).toBe(404);
    });

    it('refuses a key whose account was switched off', async () => {
        const { token } = await issued();

        await server.db.updateTable('runner.accounts').set({ active: false }).execute();

        expect((await request(server, 'GET', '/api/auth/session', { token })).status).toBe(401);
    });

    it('refuses an expired key', async () => {
        const res = await createKey(accessToken, { name: 'short', scope: 'view', expiresInDays: 1 });
        const { key, token } = (await res.json()) as { key: { id: string }; token: string };

        await server.db.updateTable('runner.apiKeys').set({ expiresAt: '2000-01-01T00:00:00Z' }).where('id', '=', key.id).execute();

        expect((await request(server, 'GET', '/api/auth/session', { token })).status).toBe(401);
    });

    it('answers 401 for the key routes with no session', async () => {
        expect((await request(server, 'GET', '/api/auth/keys')).status).toBe(401);
        expect((await createKey('garbage')).status).toBe(401);
    });

    it('answers 401 for a wl_ token that was never issued', async () => {
        expect((await request(server, 'GET', '/api/auth/session', { token: 'wl_notarealkeyatall000000000000000000000000000000' })).status).toBe(401);
    });
});
