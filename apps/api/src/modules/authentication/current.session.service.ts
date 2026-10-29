import { Injectable } from 'injectkit';
import { AuthenticationSessionService, invalidAuthenticationSession, type AuthenticationSession } from '@maroonedsoftware/authentication';
import { unauthorizedError } from '@maroonedsoftware/errors';
import { ServerKitContext } from '@maroonedsoftware/koa';
import type { CurrentSession } from '../../generated/auth.js';
import { AccountRepository } from './account.repository.js';

/**
 * `GET /api/auth/session` and `POST /api/auth/logout`: the session the caller's bearer token names,
 * as `authenticationMiddleware` resolved it onto the request.
 *
 * Takes `ServerKitContext`, so it can only be resolved inside a request; the container wiring test
 * exempts it for that reason, as it does `JobContext`.
 */
@Injectable()
export class CurrentSessionService {
    constructor(
        private readonly context: ServerKitContext,
        private readonly sessions: AuthenticationSessionService,
        private readonly accounts: AccountRepository,
    ) {}

    /** The caller's session, or 401. Rollout step 6 moves this refusal into `requirePolicy`. */
    private require(): AuthenticationSession {
        const session = this.context.authenticationSession;
        if (!session || session === invalidAuthenticationSession) {
            throw unauthorizedError('Bearer error="invalid_token"');
        }
        return session;
    }

    async get(): Promise<CurrentSession> {
        const session = this.require();
        const account = await this.accounts.get(session.subject);
        if (!account) throw unauthorizedError('Bearer error="invalid_token"');
        return { accountId: account.id, username: account.username, issuedAt: session.issuedAt, expiresAt: session.expiresAt };
    }

    /**
     * Ends the caller's session, which invalidates its access token and its refresh token together.
     * With no live session there is nothing to end, and that is still a successful sign-out.
     */
    async logout(): Promise<void> {
        const session = this.context.authenticationSession;
        if (!session || session === invalidAuthenticationSession) return;
        await this.sessions.deleteSession(session.sessionToken, 'logout');
    }
}
