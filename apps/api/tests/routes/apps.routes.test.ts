import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MAX_APP_HTML_BYTES } from '#modules/apps/apps.service.js';
import { clearAccounts, holdAccounts } from '#tests/support/test.accounts.js';
import { uniqueProject } from '#tests/support/test.db.js';
import { onboardAndSignIn, request, startTestServer, type TestServer } from '#tests/support/test.server.js';

/** Installed apps over real HTTP (`startTestServer`): who may install them, and what is stored. */
let server: TestServer;
let release: () => Promise<void>;
let session: string;

const APP = { name: 'Burndown', description: 'Cards left', html: '<h1>hello</h1>', grants: ['board.read'] };

const install = (slug: string, body: Record<string, unknown> = APP, token = session) => request(server, 'PUT', `/api/apps/${slug}`, { token, body });

const mintKey = async (scope: 'view' | 'manage'): Promise<string> => {
    const res = await request(server, 'POST', '/api/auth/keys', { token: session, body: { name: scope, scope } });
    return ((await res.json()) as { token: string }).token;
};

beforeAll(async () => {
    release = await holdAccounts();
    server = await startTestServer();
});
afterAll(async () => {
    await server.db.deleteFrom('wilson.apps').execute();
    await clearAccounts(server.db);
    await server.stop();
    await release();
});
beforeEach(async () => {
    await server.db.deleteFrom('wilson.apps').execute();
    await clearAccounts(server.db);
    ({ accessToken: session } = await onboardAndSignIn(server));
});

describe('apps', () => {
    it('installs an app and returns it with its HTML', async () => {
        const res = await install('burndown');

        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ slug: 'burndown', ...APP });
    });

    it('lists apps without their HTML', async () => {
        await install('burndown');

        const res = await request(server, 'GET', '/api/apps', { token: session });

        expect(res.status).toBe(200);
        const [app] = (await res.json()) as Record<string, unknown>[];
        expect(app).toMatchObject({ slug: 'burndown', name: 'Burndown', grants: ['board.read'] });
        expect(app).not.toHaveProperty('html');
    });

    it('replaces an app under the same slug, keeping createdAt and replacing its grants', async () => {
        const first = (await (await install('burndown')).json()) as { createdAt: string };

        const res = await install('burndown', { name: 'Burnup', html: '<h1>new</h1>', grants: ['stats.read'] });

        expect(await res.json()).toMatchObject({
            name: 'Burnup',
            description: '',
            html: '<h1>new</h1>',
            grants: ['stats.read'],
            createdAt: first.createdAt,
        });
        expect(await server.db.selectFrom('wilson.apps').select('slug').execute()).toHaveLength(1);
    });

    it('stores the app version and the API version it was written for', async () => {
        const res = await install('burndown', { ...APP, version: ' 1.2.0 ', apiVersion: 1 });

        expect(await res.json()).toMatchObject({ version: '1.2.0', apiVersion: 1 });
    });

    it('takes an app that says neither as written for API version 1, with no version', async () => {
        const app = (await (await install('burndown')).json()) as Record<string, unknown>;

        expect(app.apiVersion).toBe(1);
        expect(app).not.toHaveProperty('version');
    });

    it('refuses an API version below 1', async () => {
        expect((await install('burndown', { ...APP, apiVersion: 0 })).status).toBe(400);
    });

    it('lists each app with its versions', async () => {
        await install('burndown', { ...APP, version: '2.0.0', apiVersion: 3 });

        const [app] = (await (await request(server, 'GET', '/api/apps', { token: session })).json()) as Record<string, unknown>[];

        expect(app).toMatchObject({ version: '2.0.0', apiVersion: 3 });
    });

    it('stores a repeated grant once', async () => {
        const res = await install('burndown', { ...APP, grants: ['board.read', 'board.read'] });

        expect(await res.json()).toMatchObject({ grants: ['board.read'] });
    });

    it('drops a stored grant this build does not know', async () => {
        await install('burndown');
        await server.db
            .updateTable('wilson.apps')
            .set({ grants: ['board.read', 'retired.grant'] })
            .execute();

        const res = await request(server, 'GET', '/api/apps/burndown', { token: session });

        expect(await res.json()).toMatchObject({ grants: ['board.read'] });
    });

    it('removes an app', async () => {
        await install('burndown');

        expect((await request(server, 'DELETE', '/api/apps/burndown', { token: session })).status).toBe(204);
        expect((await request(server, 'GET', '/api/apps/burndown', { token: session })).status).toBe(404);
    });

    it('answers 404 removing an app that is not installed', async () => {
        expect((await request(server, 'DELETE', '/api/apps/nope', { token: session })).status).toBe(404);
    });

    it.each(['Burndown', '-burndown', 'burn_down', 'a'.repeat(64)])('refuses the slug %s', async slug => {
        expect((await install(slug)).status).toBe(400);
    });

    it('refuses a grant outside the list', async () => {
        expect((await install('burndown', { ...APP, grants: ['keys.read'] })).status).toBe(400);
    });

    it('refuses a blank name', async () => {
        expect((await install('burndown', { ...APP, name: '   ' })).status).toBe(400);
    });

    it('accepts HTML of exactly the limit and refuses one byte more', async () => {
        expect((await install('burndown', { ...APP, html: 'x'.repeat(MAX_APP_HTML_BYTES) })).status).toBe(200);
        expect((await install('burndown', { ...APP, html: 'x'.repeat(MAX_APP_HTML_BYTES + 1) })).status).toBe(400);
    });

    it('counts the limit in bytes, not characters', async () => {
        expect((await install('burndown', { ...APP, html: 'é'.repeat(MAX_APP_HTML_BYTES / 2 + 1) })).status).toBe(400);
    });

    describe('who may do what', () => {
        it('lets a view key read', async () => {
            await install('burndown');
            const token = await mintKey('view');

            expect((await request(server, 'GET', '/api/apps', { token })).status).toBe(200);
            expect((await request(server, 'GET', '/api/apps/burndown', { token })).status).toBe(200);
        });

        it('refuses a manage key installing, as step_up_unavailable', async () => {
            const res = await install('burndown', APP, await mintKey('manage'));

            expect(res.status).toBe(403);
            expect(await res.json()).toMatchObject({ details: { kind: 'step_up_unavailable' } });
            expect(await server.db.selectFrom('wilson.apps').select('slug').execute()).toEqual([]);
        });

        it('refuses a manage key removing', async () => {
            await install('burndown');

            const res = await request(server, 'DELETE', '/api/apps/burndown', { token: await mintKey('manage') });

            expect(res.status).toBe(403);
            expect(await server.db.selectFrom('wilson.apps').select('slug').execute()).toHaveLength(1);
        });

        it('refuses anything without a credential', async () => {
            expect((await request(server, 'GET', '/api/apps')).status).toBe(401);
        });
    });
});

describe('what apps read', () => {
    it('sends a card with the v1 fields and not the board row', async () => {
        const created = await request(server, 'POST', '/api/cards', { token: session, body: { title: 'For an app', body: 'Some text' } });
        expect(created.status).toBe(201);
        const { id } = (await created.json()) as { id: string };

        const list = await request(server, 'GET', '/api/app-api/v1/cards', { token: session });
        const one = await request(server, 'GET', `/api/app-api/v1/cards/${id}`, { token: session });

        expect(list.status).toBe(200);
        const card = ((await list.json()) as Record<string, unknown>[]).find(row => row.id === id);
        expect(card).toMatchObject({ id, title: 'For an app', needsHuman: false });
        expect(card).not.toHaveProperty('resolvedBranch');
        expect(await one.json()).toMatchObject({ id, body: expect.stringContaining('Some text') });
    });

    it('answers a card that is not there with a 404', async () => {
        const res = await request(server, 'GET', '/api/app-api/v1/cards/9999', { token: session });

        expect(res.status).toBe(404);
    });

    it('reads the columns, activity and stats', async () => {
        // A project of its own, as the columns need lanes and other suites rely on the default project having none.
        const project = uniqueProject();
        const created = await request(server, 'POST', '/api/projects', {
            token: session,
            body: { name: project, codeRoot: `/tmp/${project}/code`, worktreeRoot: `/tmp/${project}/wt`, runRoot: `/tmp/${project}/run` },
        });
        expect(created.status).toBe(201);
        const headers = { 'x-wilson-project': project };
        expect((await request(server, 'POST', '/api/board/init', { token: session, headers })).status).toBe(201);

        for (const path of ['columns', 'activity?limit=1', 'stats?days=1']) {
            const res = await request(server, 'GET', `/api/app-api/v1/${path}`, { token: session, headers });

            expect(res.status).toBe(200);
        }
    });

    it('takes a view key, which is all a person needs to look at the board', async () => {
        const res = await request(server, 'GET', '/api/app-api/v1/cards', { token: await mintKey('view') });

        expect(res.status).toBe(200);
    });
});
