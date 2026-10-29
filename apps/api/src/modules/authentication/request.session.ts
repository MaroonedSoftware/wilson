import { invalidAuthenticationSession, type AuthenticationSession } from '@maroonedsoftware/authentication';
import { unauthorizedError } from '@maroonedsoftware/errors';
import type { ServerKitContext } from '@maroonedsoftware/koa';

/** The caller's live session, or `undefined` when `authenticationMiddleware` found none. */
export const sessionOf = (context: ServerKitContext): AuthenticationSession | undefined => {
    const session = context.authenticationSession;
    return session && session !== invalidAuthenticationSession ? session : undefined;
};

/** The caller's live session, or 401. */
export const requireSession = (context: ServerKitContext): AuthenticationSession => {
    const session = sessionOf(context);
    if (!session) throw unauthorizedError('Bearer error="invalid_token"');
    return session;
};
