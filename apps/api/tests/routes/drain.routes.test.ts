import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { RunningCards } from '#modules/jobs/running.cards.js';
import { DRAIN_ENABLED } from '#modules/settings/drain.enabled.setting.js';
import { SettingsStore } from '#modules/settings/settings.store.js';
import { clearAccounts, holdAccounts } from '#tests/support/test.accounts.js';
import { onboardAndSignIn, request, startTestServer, type TestServer } from '#tests/support/test.server.js';

/** `/api/settings/drain` through the app's own container, so the service's wiring is real. */
let server: TestServer;
let release: () => Promise<void>;
let token: string;
let viewKey: string;

beforeAll(async () => {
    release = await holdAccounts();
    server = await startTestServer();
    // Nothing in this suite boots pg-boss, so its table is created here, as `card.jobs.test.ts` does.
    await sql`create schema if not exists pgboss`.execute(server.db);
    await sql`create table if not exists pgboss.job (id uuid primary key, state text not null)`.execute(server.db);
    await sql`alter table pgboss.job add column if not exists name text`.execute(server.db);
});
afterAll(async () => {
    await clearAccounts(server.db);
    await server.stop();
    await release();
});
beforeEach(async () => {
    await clearAccounts(server.db);
    ({ accessToken: token } = await onboardAndSignIn(server));
    const created = await request(server, 'POST', '/api/auth/keys', { token, body: { name: 'watcher', scope: 'view' } });
    viewKey = ((await created.json()) as { token: string }).token;
});
afterEach(async () => {
    await server.container.get(SettingsStore).set(DRAIN_ENABLED, false);
    server.container.get(RunningCards).delete('demo', '0001');
});

describe('/api/settings/drain', () => {
    it('refuses an unauthenticated read', async () => {
        expect((await request(server, 'GET', '/api/settings/drain', {})).status).toBe(401);
    });

    it('reports not draining by default, and never safe to restart', async () => {
        const res = await request(server, 'GET', '/api/settings/drain', { token: viewKey });

        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ draining: false, running: [], safeToRestart: false });
    });

    it('turns on, reports the stage still running, then says a restart is safe once it ends', async () => {
        const running = server.container.get(RunningCards);
        running.add('demo', '0001');

        const during = await request(server, 'PUT', '/api/settings/drain', { token, body: { draining: true } });
        expect(during.status).toBe(200);
        expect(await during.json()).toMatchObject({ draining: true, running: [{ project: 'demo', cardId: '0001' }], safeToRestart: false });

        running.delete('demo', '0001');

        const after = await request(server, 'GET', '/api/settings/drain', { token: viewKey });
        expect(await after.json()).toMatchObject({ draining: true, running: [], safeToRestart: true });
    });

    it('refuses a write from a view key', async () => {
        expect((await request(server, 'PUT', '/api/settings/drain', { token: viewKey, body: { draining: true } })).status).toBe(403);
    });
});
