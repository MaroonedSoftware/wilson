import { Injectable } from 'injectkit';
import {
    AuthenticationSessionService,
    JwtAuthenticationIssuer,
    invalidAuthenticationSession,
    type AuthenticationSession,
} from '@maroonedsoftware/authentication';
import { IsHttpError } from '@maroonedsoftware/errors';
import { AccountRepository } from './account.repository.js';

/**
 * Turns a wilson session token into the session it names, for `authenticationMiddleware`.
 *
 * Never throws for a bad token. A token that no longer resolves (expired, revoked, signed by
 * another key) comes back as `invalidAuthenticationSession`, as deadair's issuer does: a throw here
 * would abort the middleware chain before any route ran, including `security: none` routes such as
 * sign-out, which must work with a dead token. Routes that need a session refuse the sentinel
 * themselves (`CurrentSessionService` now, `requirePolicy` from rollout step 6).
 *
 * Also refuses a session whose account is gone or switched off, and deletes it. Sessions live in
 * `runner.cache_entries` and accounts in `runner.accounts`, and a restore of one without the other
 * would otherwise leave a token naming nobody (PROJECT.md, Authentication: Enforcement).
 *
 * The sentinel is compared by identity downstream, so this returns the exported instance itself.
 */
@Injectable()
export class WilsonJwtAuthenticationIssuer extends JwtAuthenticationIssuer {
    constructor(
        private readonly sessions: AuthenticationSessionService,
        private readonly accounts: AccountRepository,
    ) {
        super();
    }

    override async parse(token: string, _payload: unknown): Promise<AuthenticationSession> {
        let session: AuthenticationSession;
        try {
            ({ session } = await this.sessions.lookupSessionFromJwt(token));
        } catch (error) {
            if (IsHttpError(error) && error.statusCode === 401) return invalidAuthenticationSession;
            throw error;
        }
        if (!(await this.accounts.existsActive(session.subject))) {
            await this.sessions.deleteSession(session.sessionToken, 'expiry');
            return invalidAuthenticationSession;
        }
        return session;
    }
}
