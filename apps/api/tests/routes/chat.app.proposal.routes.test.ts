import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthenticationSessionService } from '@maroonedsoftware/authentication';
import { DateTime, Duration } from 'luxon';
import { AccountRepository } from '#modules/authentication/account.repository.js';
import { PROPOSED_APP_OPERATION } from '#modules/chat/chat.app.proposal.js';
import { ChatPendingActionRepository } from '#modules/chat/chat.pending.action.repository.js';
import { clearAccounts, holdAccounts } from '#tests/support/test.accounts.js';
import { onboardAndSignIn, request, startTestServer, type TestServer } from '#tests/support/test.server.js';

/**
 * Confirming a proposed app over real HTTP and the real `wilson.step.up`: the refusals reach the client
 * as a route's would, which is what makes the web app ask for a factor and retry, and each leaves the
 * action waiting. A confirm that passes starts a follow-up turn, so `chat.service.test.ts` covers that.
 */
let server: TestServer;
let release: () => Promise<void>;
let session: string;
let threadId: string;

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
    ({ accessToken: session } = await onboardAndSignIn(server));
    const thread = await request(server, 'POST', '/api/chat/threads', { token: session });
    threadId = ((await thread.json()) as { id: string }).id;
});

const propose = () =>
    server.container.get(ChatPendingActionRepository).propose(threadId, {
        operation: PROPOSED_APP_OPERATION,
        arguments: { slug: 'open-cards', name: 'Open cards', html: '<h1>open</h1>', requestedGrants: ['board.read'] },
        summary: 'Install Open cards.',
        expiresIn: Duration.fromObject({ minutes: 10 }),
    });

const confirm = (id: string, token: string, grants?: string[]) =>
    request(server, 'POST', `/api/chat/actions/${id}/decision`, { token, body: { decision: 'confirm', ...(grants ? { grants } : {}) } });

const statusOf = async (id: string) => (await server.container.get(ChatPendingActionRepository).get(id))!.status;

const kindOf = async (res: Response) => ((await res.json()) as { details?: { kind?: string } }).details?.kind;

const sessionProvedAgo = async (minutes: number): Promise<string> => {
    const account = await server.container.get(AccountRepository).findByEmail('operator@example.com');
    const sessions = server.container.get(AuthenticationSessionService);
    const at = DateTime.utc().minus({ minutes });
    const created = await sessions.createSession(
        account!.id,
        {},
        { method: 'password', methodId: randomUUID(), kind: 'knowledge', issuedAt: at, authenticatedAt: at },
    );
    return (await sessions.issueTokenForSession(created.sessionToken)).accessToken;
};

describe('confirming a proposed app', () => {
    it('asks a session whose factor is old to prove one, and keeps the action waiting', async () => {
        const action = await propose();

        const res = await confirm(action.id, await sessionProvedAgo(6), ['board.read']);

        expect(res.status).toBe(403);
        expect(await kindOf(res)).toBe('step_up_required');
        expect(await statusOf(action.id)).toBe('pending');
    });

    it('refuses an API key outright, and keeps the action waiting', async () => {
        const action = await propose();
        const created = await request(server, 'POST', '/api/auth/keys', { token: session, body: { name: 'cli', scope: 'manage' } });
        const { token } = (await created.json()) as { token: string };

        const res = await confirm(action.id, token, ['board.read']);

        expect(res.status).toBe(403);
        expect(await kindOf(res)).toBe('step_up_unavailable');
        expect(await statusOf(action.id)).toBe('pending');
    });

    it('refuses a client that sends no grants, before asking anyone to sign in', async () => {
        const action = await propose();

        const res = await confirm(action.id, await sessionProvedAgo(6));

        expect(res.status).toBe(400);
        expect(await statusOf(action.id)).toBe('pending');
    });

    it('refuses a grant outside the list', async () => {
        const action = await propose();

        const res = await confirm(action.id, session, ['board.write']);

        expect(res.status).toBe(400);
        expect(await statusOf(action.id)).toBe('pending');
    });
});
