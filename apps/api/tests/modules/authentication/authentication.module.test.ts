import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Container } from 'injectkit';
import { Kysely } from 'kysely';
import { DateTime } from 'luxon';
import { AuthenticationSessionService } from '@maroonedsoftware/authentication';
import { ServerKitServerBuilder } from '@maroonedsoftware/koa';
import { ConsoleLogger } from '@maroonedsoftware/logger';
import { SESSION_ISSUER } from '#modules/authentication/authentication.module.js';
import type { DB } from '#modules/data/db.js';
import { modules } from '#modules/modules.js';
import { buildTestServerConfig } from '#tests/support/test.config.js';

/**
 * Rollout step 2 (PROJECT.md, Authentication). Nothing calls the session machinery yet, so this is
 * what proves it works: the app's own container, against the test database, creating a session,
 * issuing a token for it, reading the token back, and revoking it. That exercises the signing key,
 * `PostgresCacheProvider` as the session store, and its set methods as the per-subject index.
 */
let container: Container;
beforeAll(async () => {
    container = await new ServerKitServerBuilder().setup(await buildTestServerConfig(), new ConsoleLogger(), modules);
});
afterAll(async () => {
    await container.get(Kysely<DB>).destroy();
});

const passwordFactor = () => ({
    method: 'password' as const,
    methodId: randomUUID(),
    kind: 'knowledge' as const,
    issuedAt: DateTime.now(),
    authenticatedAt: DateTime.now(),
});

describe('AuthenticationModule', () => {
    it('issues a token that reads back as the session it names', async () => {
        const sessions = container.get(AuthenticationSessionService);
        const subject = `test-subject-${randomUUID()}`;

        const session = await sessions.createSession(subject, {}, passwordFactor());
        const { accessToken } = await sessions.issueTokenForSession(session.sessionToken);
        const { session: found } = await sessions.lookupSessionFromJwt(accessToken);

        expect(found.sessionToken).toBe(session.sessionToken);
        expect(found.subject).toBe(subject);
    });

    it('signs as wilson, so a token from another app is not mistaken for one of ours', async () => {
        const sessions = container.get(AuthenticationSessionService);
        const session = await sessions.createSession(`test-subject-${randomUUID()}`, {}, passwordFactor());

        const { accessToken } = await sessions.issueTokenForSession(session.sessionToken);
        const claims = JSON.parse(Buffer.from(accessToken.split('.')[1]!, 'base64url').toString('utf8')) as { iss: string; aud: string };

        expect(claims.iss).toBe(SESSION_ISSUER);
        expect(claims.aud).toBe(SESSION_ISSUER);
    });

    it('lists every session a subject holds, and none once they are revoked', async () => {
        const sessions = container.get(AuthenticationSessionService);
        const subject = `test-subject-${randomUUID()}`;
        await Promise.all([sessions.createSession(subject, {}, passwordFactor()), sessions.createSession(subject, {}, passwordFactor())]);

        expect(await sessions.getSessionsForSubject(subject)).toHaveLength(2);

        expect(await sessions.revokeAllForSubject(subject)).toBe(2);
        expect(await sessions.getSessionsForSubject(subject)).toEqual([]);
    });

    it('refuses a token whose session was deleted', async () => {
        const sessions = container.get(AuthenticationSessionService);
        const session = await sessions.createSession(`test-subject-${randomUUID()}`, {}, passwordFactor());
        const { accessToken } = await sessions.issueTokenForSession(session.sessionToken);

        await sessions.deleteSession(session.sessionToken);

        await expect(sessions.lookupSessionFromJwt(accessToken)).rejects.toThrow();
    });
});
