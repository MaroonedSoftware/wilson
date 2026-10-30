import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearAccounts, holdAccounts } from '#tests/support/test.accounts.js';
import { onboardAndSignIn, request, startTestServer, type TestServer } from '#tests/support/test.server.js';

const ROUTE = '/api/settings/engine-token';
const TOKEN = 'sk-ant-oat-route-test';

/** The engine token over real HTTP (`startTestServer`): write-only, and for managers alone. */
let server: TestServer;
let release: () => Promise<void>;
let accessToken: string;

const put = (token: string, value: string | null) => request(server, 'PUT', ROUTE, { token, body: { token: value } });

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
    await put(accessToken, null);
});

describe('/api/settings/engine-token', () => {
    it('never returns the token, from either verb', async () => {
        const saved = await put(accessToken, TOKEN);
        expect(saved.status).toBe(200);
        expect(await saved.text()).not.toContain(TOKEN);

        const read = await request(server, 'GET', ROUTE, { token: accessToken });
        const body = await read.json();
        expect(body).toEqual({ source: 'database' });
        expect(JSON.stringify(body)).not.toContain(TOKEN);
    });

    it('leaves ciphertext in the row', async () => {
        await put(accessToken, TOKEN);

        const row = await server.db.selectFrom('wilson.settings').select('value').where('key', '=', 'engine-oauth-token').executeTakeFirstOrThrow();

        expect(JSON.stringify(row.value)).not.toContain(TOKEN);
    });

    it('removes the saved token on null', async () => {
        await put(accessToken, TOKEN);

        const res = await put(accessToken, null);

        expect(await res.json()).not.toEqual({ source: 'database' });
    });

    it('refuses a token with a space in it', async () => {
        expect((await put(accessToken, 'two words')).status).toBe(400);
    });

    it('lets a view-scoped key read, and not write', async () => {
        const created = await request(server, 'POST', '/api/auth/keys', { token: accessToken, body: { name: 'viewer', scope: 'view' } });
        const { token: viewKey } = (await created.json()) as { token: string };

        expect((await request(server, 'GET', ROUTE, { token: viewKey })).status).toBe(200);
        expect((await put(viewKey, TOKEN)).status).toBe(403);
    });
});
