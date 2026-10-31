import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearAccounts, holdAccounts } from '#tests/support/test.accounts.js';
import { onboardAndSignIn, request, startTestServer, type TestServer } from '#tests/support/test.server.js';

/** Push devices over real HTTP: a phone signing up for notifications, and leaving. */
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

const rows = () => server.db.selectFrom('wilson.pushDevices').select(['token', 'label']).execute();

describe('push devices', () => {
    it('refuses a caller with no session', async () => {
        expect((await request(server, 'POST', '/api/devices', { body: { token: 'fcm-1' } })).status).toBe(401);
        expect(await rows()).toHaveLength(0);
    });

    it('registers a device under the signed-in account', async () => {
        const res = await request(server, 'POST', '/api/devices', { token: accessToken, body: { token: 'fcm-1', label: 'Pixel' } });

        expect(res.status).toBe(204);
        expect(await rows()).toEqual([{ token: 'fcm-1', label: 'Pixel' }]);
    });

    it('updates the row when the same phone registers again', async () => {
        await request(server, 'POST', '/api/devices', { token: accessToken, body: { token: 'fcm-1', label: 'Pixel' } });
        await request(server, 'POST', '/api/devices', { token: accessToken, body: { token: 'fcm-1', label: 'Pixel 12' } });

        expect(await rows()).toEqual([{ token: 'fcm-1', label: 'Pixel 12' }]);
    });

    it('unregisters a device, and answers the same for one it never had', async () => {
        await request(server, 'POST', '/api/devices', { token: accessToken, body: { token: 'fcm-1' } });

        expect((await request(server, 'POST', '/api/devices/unregister', { token: accessToken, body: { token: 'fcm-1' } })).status).toBe(204);
        expect((await request(server, 'POST', '/api/devices/unregister', { token: accessToken, body: { token: 'fcm-1' } })).status).toBe(204);
        expect(await rows()).toHaveLength(0);
    });

    it('refuses an empty token', async () => {
        expect((await request(server, 'POST', '/api/devices', { token: accessToken, body: { token: '' } })).status).toBe(400);
    });
});
