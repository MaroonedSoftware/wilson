import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearAccounts, holdAccounts } from '#tests/support/test.accounts.js';
import { onboardAndSignIn, request, startTestServer, type TestServer } from '#tests/support/test.server.js';
import { uniqueProject } from '#tests/support/test.db.js';

/**
 * `ProjectContextRouter` over real HTTP: whether a project exists is told only to a caller with a
 * live session. Before, a registered name reached the route's 401 and an unknown one got the 400
 * naming it, so anyone could test names without a credential.
 */
let server: TestServer;
let release: () => Promise<void>;
let session: string;
let registered: string;

beforeAll(async () => {
    release = await holdAccounts();
    server = await startTestServer();
    await clearAccounts(server.db);
    ({ accessToken: session } = await onboardAndSignIn(server));
    registered = uniqueProject();
    const created = await request(server, 'POST', '/api/projects', {
        token: session,
        body: { name: registered, codeRoot: `/tmp/${registered}/code`, worktreeRoot: `/tmp/${registered}/wt`, runRoot: `/tmp/${registered}/run` },
    });
    expect(created.status).toBe(201);
});
afterAll(async () => {
    await clearAccounts(server.db);
    await server.stop();
    await release();
});

const answer = async (res: Response) => ({ status: res.status, body: await res.text(), challenge: res.headers.get('www-authenticate') });

describe('a named project', () => {
    it('answers an anonymous caller the same for a registered name and an unknown one, by header', async () => {
        const known = await request(server, 'GET', '/api/cards', { headers: { 'x-wilson-project': registered } });
        const unknown = await request(server, 'GET', '/api/cards', { headers: { 'x-wilson-project': 'no-such-project' } });

        expect(known.status).toBe(401);
        expect(await answer(unknown)).toEqual(await answer(known));
    });

    it('answers the same by query, and for a token that no longer resolves', async () => {
        const known = await request(server, 'GET', `/api/feed?project=${registered}`, { token: 'not-a-token' });
        const unknown = await request(server, 'GET', '/api/feed?project=no-such-project', { token: 'not-a-token' });

        expect(known.status).toBe(401);
        expect(await answer(unknown)).toEqual(await answer(known));
    });

    it('still lets an anonymous caller reach a public route when naming a project', async () => {
        const res = await request(server, 'GET', '/api/health', { headers: { 'x-wilson-project': 'no-such-project' } });

        expect(res.status).toBe(200);
    });

    it('still refuses a signed-in caller naming an unknown project, by name', async () => {
        const res = await request(server, 'GET', '/api/cards', { token: session, headers: { 'x-wilson-project': 'no-such-project' } });

        expect(res.status).toBe(400);
        expect(await res.text()).toContain('no-such-project');
    });
});
