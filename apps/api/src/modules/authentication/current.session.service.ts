import { Injectable } from 'injectkit';
import { AuthenticationSessionService } from '@maroonedsoftware/authentication';
import { unauthorizedError } from '@maroonedsoftware/errors';
import { ServerKitContext } from '@maroonedsoftware/koa';
import type { CurrentSession } from '../../generated/auth.js';
import { AccountRepository } from './account.repository.js';
import { requireSession, sessionOf } from './request.session.js';
import { clearSessionCookies } from './session.cookies.js';

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

    async get(): Promise<CurrentSession> {
        // Rollout step 6 moves this refusal into `requirePolicy`.
        const session = requireSession(this.context);
        const account = await this.accounts.get(session.subject);
        if (!account) throw unauthorizedError('Bearer error="invalid_token"');
        return { accountId: account.id, username: account.username, issuedAt: session.issuedAt, expiresAt: session.expiresAt };
    }

    /**
     * Ends the caller's session, which invalidates its access token and its refresh token together.
     * With no live session there is nothing to end, and that is still a successful sign-out. The
     * web app's cookies are cleared either way.
     */
    async logout(): Promise<void> {
        clearSessionCookies(this.context);
        const session = sessionOf(this.context);
        if (!session) return;
        await this.sessions.deleteSession(session.sessionToken, 'logout');
    }
}
