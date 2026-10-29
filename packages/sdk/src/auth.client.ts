import type { CurrentSession, PasskeyChallenge, PasskeyChallengeRequest, TokenRequest, TokenResponse } from './types/auth.js';
import { reviveCurrentSession } from './types/auth.js';
import type { SdkFetch } from './sdk-options.js';
import { bigIntReplacer, parseJson } from './sdk-options.js';

/**
 * generated from [auth.ck](../../../apps/api/data/contracts/auth.ck)
 */
export class AuthClient {
    constructor(private fetch: SdkFetch) {}

    /** @name Sign in */
    async requestToken(body: TokenRequest): Promise<TokenResponse> {
        const result = await this.fetch(`/api/auth/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return await parseJson<TokenResponse>(result);
    }

    /**
     * @name Start a passkey sign-in step
     * @description The passkey half of the second step: a challenge for the browser to sign, issued against the
     * sign-in the password started. `security: none`, like `token`: the pending sign-in's challenge is
     * what authorizes it, and it is good for one sign-in.
     */
    async startPasskeyChallenge(body: PasskeyChallengeRequest): Promise<PasskeyChallenge> {
        const result = await this.fetch(`/api/auth/passkey/challenge`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return await parseJson<PasskeyChallenge>(result);
    }

    /** @name Get the current session */
    async getCurrentSession(): Promise<CurrentSession> {
        const result = await this.fetch(`/api/auth/session`, { method: 'GET' });
        return reviveCurrentSession(await parseJson<CurrentSession>(result));
    }

    /** @name Sign out */
    async logout(): Promise<void> {
        await this.fetch(`/api/auth/logout`, { method: 'POST' });
    }
}
