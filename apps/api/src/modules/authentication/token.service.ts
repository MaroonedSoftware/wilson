import { Injectable } from 'injectkit';
import { DateTime } from 'luxon';
import {
    AuthenticationSessionService,
    PasswordFactorService,
    PasswordHashProvider,
    type AuthenticationToken,
} from '@maroonedsoftware/authentication';
import { httpError, IsHttpError, unauthorizedError } from '@maroonedsoftware/errors';
import { ServerKitContext } from '@maroonedsoftware/koa';
import type { TokenRequest, TokenResponse } from '../../generated/auth.js';
import { AccountRepository } from './account.repository.js';
import { PasswordRateLimiter } from './password.factors.js';
import { clearSessionCookies, refreshCookieOf, setSessionCookies, wantsCookies } from './session.cookies.js';

/** The `WWW-Authenticate` challenge for a grant that was refused: wrong password, dead refresh token. */
const INVALID_GRANT = 'Bearer error="invalid_grant"';

let dummyHash: Promise<{ hash: string; salt: string }> | undefined;

/**
 * `POST /api/auth/token`: every way of getting a session (PROJECT.md, Authentication).
 *
 * Two grants for now. `password` signs in and mints a new session. `refresh_token` hands the
 * refresh token to `AuthenticationSessionService.refreshSession`, which makes it single-use: it
 * consumes the token's `jti`, rotates to a fresh pair, and on a replay of a spent one revokes the
 * whole token family. Reimplementing refresh as "look the session up and issue a token" would skip
 * all of that and leave refresh tokens replayable forever, which is the note deadair leaves on the
 * same method.
 *
 * Only one factor so far, so a password alone signs in. Rollout step 7 adds TOTP and passkeys, and
 * this is where the second-factor challenge will go.
 *
 * The web app sends `x-wilson-cookies: 1` and gets its tokens as cookies (`session.cookies.ts`):
 * the refresh token never enters the response body, so no script on the page can read it, and a
 * `refresh_token` grant with no token in the body redeems the cookie. Takes `ServerKitContext` for
 * that, so the container wiring test exempts it.
 */
@Injectable()
export class TokenService {
    constructor(
        private readonly context: ServerKitContext,
        private readonly accounts: AccountRepository,
        private readonly passwords: PasswordFactorService,
        private readonly hashes: PasswordHashProvider,
        private readonly limiter: PasswordRateLimiter,
        private readonly sessions: AuthenticationSessionService,
    ) {}

    async requestToken(request: TokenRequest): Promise<TokenResponse> {
        switch (request.grant_type) {
            case 'password':
                return this.password(request);
            case 'refresh_token':
                return this.refresh(request);
        }
    }

    private async password(request: TokenRequest): Promise<TokenResponse> {
        const { username, password } = request;
        if (!username || !password) {
            throw httpError(400).withDetails({ reason: 'the password grant needs a username and a password' });
        }

        const account = await this.accounts.findByUsername(username.trim());
        if (!account?.active) {
            await this.refuseUnknownAccount(username, password);
        }

        // Spends a point from the limiter, answers 429 once it is spent, and 401 for a wrong password.
        const factor = await this.passwords.verifyPassword(account!.id, password);
        const now = DateTime.utc();
        const session = await this.sessions.createSession(
            account!.id,
            {},
            {
                method: 'password',
                methodId: factor.id,
                kind: 'knowledge',
                issuedAt: now,
                authenticatedAt: now,
            },
        );
        return this.respond(await this.sessions.issueTokenForSession(session.sessionToken));
    }

    /**
     * A username that is not an account costs what a wrong password costs: one point from the same
     * limiter, under the name typed, and one Argon2 verify. Otherwise an unknown name would answer
     * at once and never reach 429, and how a guess failed would say whether the account exists.
     */
    private async refuseUnknownAccount(username: string, password: string): Promise<never> {
        try {
            await this.limiter.consume(`unknown:${username.trim().toLowerCase()}`);
        } catch {
            throw httpError(429);
        }
        dummyHash ??= this.hashes.hash('wilson-unknown-account');
        const { hash, salt } = await dummyHash;
        await this.hashes.verify(password, hash, salt);
        throw unauthorizedError(INVALID_GRANT);
    }

    private async refresh(request: TokenRequest): Promise<TokenResponse> {
        const presented = request.refresh_token ?? refreshCookieOf(this.context);
        if (!presented) {
            throw httpError(400).withDetails({ reason: 'the refresh_token grant needs a refresh_token' });
        }
        try {
            const token = await this.sessions.refreshSession(presented, undefined, async session => {
                // Runs after the token is verified and its jti claimed, before anything is minted: a
                // session naming an account that is gone or switched off is ended, not renewed.
                if (await this.accounts.existsActive(session.subject)) return;
                await this.sessions.deleteSession(session.sessionToken, 'expiry');
                throw unauthorizedError(INVALID_GRANT);
            });
            return this.respond(token);
        } catch (err) {
            // A cookie the session service refused (4xx: spent, revoked, expired) will never work, so
            // stop the browser presenting it on every load. Anything else is not about the token, and
            // dropping a good 30-day cookie over a database blip would sign the operator out for
            // nothing: deadair's reasoning on the same branch.
            if (request.refresh_token === undefined && IsHttpError(err) && err.statusCode < 500) clearSessionCookies(this.context);
            throw err;
        }
    }

    /** The token as the caller asked for it: in the body, or (the web app) as cookies. */
    private respond(token: AuthenticationToken): TokenResponse {
        // `issueTokenForSession` and `refreshSession` always mint a refresh token; the type allows
        // its absence only for grants this API does not offer.
        if (!token.refreshToken) throw httpError(500).withInternalDetails({ message: 'session token issued without a refresh token' });
        const response = { accessToken: token.accessToken, expiresIn: token.expiresIn, tokenType: token.tokenType };
        if (wantsCookies(this.context)) {
            setSessionCookies(this.context, { accessToken: token.accessToken, refreshToken: token.refreshToken, expiresIn: token.expiresIn });
            return response;
        }
        return { ...response, refreshToken: token.refreshToken };
    }
}
