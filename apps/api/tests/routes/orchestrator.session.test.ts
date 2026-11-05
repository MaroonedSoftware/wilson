import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Logger } from '@maroonedsoftware/logger';
import { ChatCatalog } from '#modules/chat/chat.catalog.js';
import { ChatThreadRepository } from '#modules/chat/chat.thread.repository.js';
import { orchestratorSession } from '#modules/goal/orchestrator.session.js';
import { startTestServer, type TestServer } from '#tests/support/test.server.js';

/** What a wake-up's session may do, through the real catalog and the real policies. */
let server: TestServer;
let project: string;

const run = (name: string, args: Record<string, unknown> = {}) =>
    server.container.get(ChatCatalog).run(server.container, server.container.get(Logger), orchestratorSession(), name, args, project);

beforeAll(async () => {
    server = await startTestServer();
    project = `orchestrator-${randomUUID()}`;
    await server.db.insertInto('wilson.projects').values({ name: project, codeRoot: '/c', worktreeRoot: '/w', runRoot: '/r' }).execute();
});
afterAll(async () => {
    await server.stop();
});

describe('the orchestrator session', () => {
    it('can read', async () => {
        await expect(run('list_goals', { query: { project } })).resolves.toEqual({ items: [] });
    });

    it('cannot make a change, even one a person could', async () => {
        const threadId = (await server.container.get(ChatThreadRepository).create('a thread', 'api')).id;

        await expect(run('create_a_goal', { body: { threadId, project, title: 'Add SSO', outcome: 'o' } })).rejects.toThrow();
        await expect(run('set_auto_split_setting', { body: { enabled: true } })).rejects.toThrow();

        expect(await run('list_goals', { query: { project } })).toEqual({ items: [] });
    });

    it('is built afresh, and expires', () => {
        const session = orchestratorSession();

        expect(session.subject).toBe('orchestrator');
        expect(session.expiresAt > session.issuedAt).toBe(true);
    });
});
