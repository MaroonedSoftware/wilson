import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { AuthenticationSessionService } from '@maroonedsoftware/authentication';
import { AccountRepository } from '#modules/authentication/account.repository.js';
import { clearAccounts, holdAccounts } from '#tests/support/test.accounts.js';
import { onboardAndSignIn, request, startTestServer, type TestServer } from '#tests/support/test.server.js';

/**
 * `wilson.step.up` over real HTTP: minting or rotating a key and saving stage config need a factor
 * proved in the last five minutes, which no API key ever is (PROJECT.md, Authentication: Factors).
 */
let server: TestServer;
let release: () => Promise<void>;
let freshSession: string;
let manageKey: string;

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
    ({ accessToken: freshSession } = await onboardAndSignIn(server));
    const created = await request(server, 'POST', '/api/auth/keys', { token: freshSession, body: { name: 'cli', scope: 'manage' } });
    manageKey = ((await created.json()) as { token: string }).token;
});

/** A real session whose password was proved `minutes` ago, minted straight through the session service. */
const sessionProvedAgo = async (minutes: number): Promise<string> => {
    const account = await server.container.get(AccountRepository).findByEmail('operator@example.com');
    const sessions = server.container.get(AuthenticationSessionService);
    const at = DateTime.utc().minus({ minutes });
    const session = await sessions.createSession(
        account!.id,
        {},
        { method: 'password', methodId: randomUUID(), kind: 'knowledge', issuedAt: at, authenticatedAt: at },
    );
    return (await sessions.issueTokenForSession(session.sessionToken)).accessToken;
};

const kindOf = async (res: Response) => ((await res.json()) as { details?: { kind?: string } }).details?.kind;

const STAGE_SAVE = { yaml: 'not: [valid', message: 'step-up check' };

describe('step-up', () => {
    it('lets a session that just signed in mint a key', async () => {
        expect((await request(server, 'POST', '/api/auth/keys', { token: freshSession, body: { name: 'another', scope: 'view' } })).status).toBe(201);
    });

    it('refuses a manage key minting a key, as step_up_unavailable', async () => {
        const res = await request(server, 'POST', '/api/auth/keys', { token: manageKey, body: { name: 'another', scope: 'view' } });

        expect(res.status).toBe(403);
        expect(await kindOf(res)).toBe('step_up_unavailable');
    });

    it('refuses a manage key saving stage config, as step_up_unavailable', async () => {
        const res = await request(server, 'PUT', '/api/stages/config', { token: manageKey, body: STAGE_SAVE });

        expect(res.status).toBe(403);
        expect(await kindOf(res)).toBe('step_up_unavailable');
    });

    it('refuses a session whose factor is older than five minutes, as step_up_required', async () => {
        const stale = await sessionProvedAgo(6);

        const res = await request(server, 'POST', '/api/auth/keys', { token: stale, body: { name: 'another', scope: 'view' } });

        expect(res.status).toBe(403);
        expect(await kindOf(res)).toBe('step_up_required');
    });

    it('admits a session proved within the window to the stage config save', async () => {
        const recent = await sessionProvedAgo(4);

        // Past the gate: the invalid document is refused by the service itself, with 400.
        expect((await request(server, 'PUT', '/api/stages/config', { token: recent, body: STAGE_SAVE })).status).toBe(400);
    });

    it('still lets a manage key read stage config', async () => {
        expect((await request(server, 'GET', '/api/stages/config', { token: manageKey })).status).not.toBe(403);
    });
});
