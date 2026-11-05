import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ChatThreadRepository } from '#modules/chat/chat.thread.repository.js';
import { clearAccounts, holdAccounts } from '#tests/support/test.accounts.js';
import { onboardAndSignIn, startTestServer, type TestServer } from '#tests/support/test.server.js';

/** Goals over real HTTP (`startTestServer`): the contract's validation, status codes and policy. */
let server: TestServer;
let release: () => Promise<void>;
let accessToken: string;
let project: string;

const call = (path: string, method = 'GET', body?: unknown, token: string | undefined = accessToken) =>
    fetch(`${server.base}${path}`, {
        method,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
const newThread = async () => (await server.container.get(ChatThreadRepository).create('a thread', 'api')).id;

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
    project = `goal-routes-${randomUUID()}`;
    await server.db.insertInto('wilson.projects').values({ name: project, codeRoot: '/c', worktreeRoot: '/w', runRoot: '/r' }).execute();
});

describe('goals', () => {
    it('needs a credential', async () => {
        expect((await call('/api/goals', 'GET', undefined, '')).status).toBe(401);
    });

    it('creates a goal, reads it, lists it and pauses it', async () => {
        const threadId = await newThread();

        const created = await call('/api/goals', 'POST', { threadId, project, title: 'Add SSO', outcome: 'People sign in with SSO' });
        expect(created.status).toBe(201);
        const goal = (await created.json()) as { id: string };

        const read = (await (await call(`/api/goals/${goal.id}`)).json()) as { goal: { title: string }; cards: unknown[] };
        expect(read).toMatchObject({ goal: { title: 'Add SSO', status: 'active' }, cards: [] });

        const listed = (await (await call(`/api/goals?project=${project}&status=active`)).json()) as { id: string }[];
        expect(listed.map(found => found.id)).toEqual([goal.id]);

        const paused = await call(`/api/goals/${goal.id}`, 'PATCH', { status: 'paused' });
        expect(((await paused.json()) as { status: string }).status).toBe('paused');
    });

    it('adds and removes a card', async () => {
        await server.db.insertInto('wilson.cards').values({ project, id: '0001', title: 'A card', stage: 'planning', body: '' }).execute();
        const created = await call('/api/goals', 'POST', { threadId: await newThread(), project, title: 'Add SSO', outcome: 'o' });
        const { id } = (await created.json()) as { id: string };

        const added = await call(`/api/goals/${id}/cards/0001`, 'PUT');
        expect(((await added.json()) as { cards: { id: string }[] }).cards.map(card => card.id)).toEqual(['0001']);

        const removed = await call(`/api/goals/${id}/cards/0001`, 'DELETE');
        expect(((await removed.json()) as { cards: unknown[] }).cards).toEqual([]);
    });

    it('refuses a status that is not one', async () => {
        const created = await call('/api/goals', 'POST', { threadId: await newThread(), project, title: 'Add SSO', outcome: 'o' });
        const { id } = (await created.json()) as { id: string };

        expect((await call(`/api/goals/${id}`, 'PATCH', { status: 'finished' })).status).toBe(400);
    });
});
