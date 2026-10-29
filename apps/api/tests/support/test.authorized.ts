import { DateTime } from 'luxon';
import type { AuthenticationSession } from '@maroonedsoftware/authentication';
import { PolicyService } from '@maroonedsoftware/policies';

/** A signed-in session, for a test that drives a gated route through a hand-built context. */
export const SIGNED_IN: AuthenticationSession = {
    sessionToken: 'test-session',
    subject: 'test-account',
    issuedAt: DateTime.utc(),
    expiresAt: DateTime.utc().plus({ hours: 1 }),
    lastAccessedAt: DateTime.utc(),
    factors: [],
    claims: {},
};

const allowAll = { check: async () => ({ allowed: true }), assert: async () => undefined };

/**
 * Make a hand-built route context pass `requirePolicy` (PROJECT.md decision 10), in place: a
 * signed-in session, and a `PolicyService` that allows. For a test about what a gated route does
 * once admitted; whether routes are gated at all is `tests/security/authz.coverage.test.ts`'s job,
 * against the real policies.
 */
export const authorize = <C extends { container: { get: (token: unknown) => unknown } }>(ctx: C): C => {
    const inner = ctx.container.get.bind(ctx.container);
    Object.assign(ctx, {
        authenticationSession: SIGNED_IN,
        container: { get: (token: unknown) => (token === PolicyService ? allowAll : inner(token)) },
    });
    return ctx;
};
