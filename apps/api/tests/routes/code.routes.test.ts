import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConsoleLogger } from '@maroonedsoftware/logger';
import { ChatCatalog, explainError } from '#modules/chat/chat.catalog.js';
import { clearAccounts, holdAccounts } from '#tests/support/test.accounts.js';
import { uniqueProject } from '#tests/support/test.db.js';
import { onboardAndSignIn, request, startTestServer, type TestServer } from '#tests/support/test.server.js';
import { fakeSession } from '../modules/chat/chat.fakes.js';

/**
 * `code.ck` through the app's own container, so the service's wiring is real: a project with no
 * cards, reached over HTTP and through the chat's catalog, where a turn has no request of its own.
 */
let server: TestServer;
let release: () => Promise<void>;
let token: string;
let viewKey: string;
let accountId: string;
let project: string;
let root: string;
let head: string;

const asProject = () => ({ 'x-wilson-project': project });
const recordsFor = (name: string) => server.db.selectFrom('wilson.codeReads').selectAll().where('project', '=', name).orderBy('id').execute();

beforeAll(async () => {
    release = await holdAccounts();
    server = await startTestServer();
    await clearAccounts(server.db);
    ({ accessToken: token } = await onboardAndSignIn(server));
    const created = await request(server, 'POST', '/api/auth/keys', { token, body: { name: 'reader', scope: 'view' } });
    viewKey = ((await created.json()) as { token: string }).token;
    accountId = ((await (await request(server, 'GET', '/api/auth/session', { token })).json()) as { accountId: string }).accountId;

    root = mkdtempSync(join(tmpdir(), 'code-routes-'));
    const git = (...args: string[]) =>
        execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd: root, encoding: 'utf8' }).trim();
    git('init', '-q');
    writeFileSync(join(root, 'login.ts'), 'export const login = () => "needle";\n');
    git('add', '.');
    git('commit', '-qm', 'first');
    head = git('rev-parse', 'HEAD');

    project = uniqueProject();
    const registered = await request(server, 'POST', '/api/projects', {
        token,
        body: { name: project, codeRoot: root, worktreeRoot: `${root}-wt`, runRoot: `${root}-run` },
    });
    expect(registered.status).toBe(201);
});
afterAll(async () => {
    await clearAccounts(server.db);
    await server.stop();
    await release();
    rmSync(root, { recursive: true, force: true });
});

describe('over HTTP', () => {
    it('refuses a request with no session', async () => {
        for (const path of ['/api/code/tree', '/api/code/file?path=login.ts', '/api/code/search?pattern=x']) {
            expect((await request(server, 'GET', path, { headers: asProject() })).status).toBe(401);
        }
    });

    it('lists, reads and searches a project with no cards, on a view key, naming the commit', async () => {
        const headers = asProject();

        const tree = await request(server, 'GET', '/api/code/tree', { token: viewKey, headers });
        expect(tree.status).toBe(200);
        expect(await tree.json()).toEqual({ commit: head, path: '', entries: [{ name: 'login.ts', path: 'login.ts', type: 'file', size: 37 }] });

        const file = await request(server, 'GET', '/api/code/file?path=login.ts&offset=1&limit=5', { token: viewKey, headers });
        expect(file.status).toBe(200);
        expect(await file.json()).toEqual({
            commit: head,
            path: 'login.ts',
            content: 'export const login = () => "needle";',
            offset: 1,
            totalLines: 1,
        });

        const search = await request(server, 'GET', '/api/code/search?pattern=needle', { token: viewKey, headers });
        expect(search.status).toBe(200);
        expect(await search.json()).toEqual({
            commit: head,
            matches: [{ path: 'login.ts', line: 1, excerpt: 'export const login = () => "needle";' }],
            truncated: false,
        });
    });

    it('refuses a project that is not registered, by name', async () => {
        const res = await request(server, 'GET', '/api/code/tree', { token, headers: { 'x-wilson-project': 'no-such-project' } });

        expect(res.status).toBe(400);
        expect(await res.text()).toContain('no-such-project');
    });

    it('answers a refusal with a 400 and its reason, and records it under the session', async () => {
        const res = await request(server, 'GET', `/api/code/file?path=${encodeURIComponent('/etc/passwd')}`, { token, headers: asProject() });

        expect(res.status).toBe(400);
        expect(await res.text()).toContain('absolute');
        expect((await recordsFor(project)).at(-1)).toMatchObject({ operation: 'read', path: '/etc/passwd', outcome: 'refused', subject: accountId });
    });
});

describe('through the chat catalog', () => {
    const logger = new ConsoleLogger();
    const catalog = () => server.container.get(ChatCatalog);

    it.each(['list_project_code', 'read_project_file', 'search_project_code'])('offers %s as a read, so no confirmation is asked', name => {
        expect(catalog().get(name)).toMatchObject({ readOnly: true });
    });

    it('reads as the person whose turn it is, with no request behind it', async () => {
        const page = await catalog().run(server.container, logger, fakeSession, 'read_project_file', { query: { path: 'login.ts' } }, project);

        expect(page).toMatchObject({ commit: head, content: 'export const login = () => "needle";' });
        expect((await recordsFor(project)).at(-1)).toMatchObject({
            operation: 'read',
            outcome: 'read',
            subject: fakeSession.subject,
            commitSha: head,
        });
    });

    it('refuses a project that is not registered, by name', async () => {
        const failure = await catalog()
            .run(server.container, logger, fakeSession, 'list_project_code', {}, 'no-such-project')
            .catch(err => err);

        expect(explainError(failure)).toBe('project "no-such-project" is not registered');
    });

    it("explains a refusal in the reader's own words", async () => {
        const failure = await catalog()
            .run(server.container, logger, fakeSession, 'read_project_file', { query: { path: '.env' } }, project)
            .catch(err => err);

        expect(explainError(failure)).toContain('deny list');
    });
});
