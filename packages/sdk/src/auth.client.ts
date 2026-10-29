import type { CurrentSession, TokenRequest, TokenResponse } from './types/auth.js';
import type { SdkFetch } from './sdk-options.js';
import { bigIntReplacer, parseJson } from './sdk-options.js';

/**
 * generated from [auth.ck](file://./../../../apps/api/data/contracts/auth.ck)
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

    /** @name Get the current session */
    async getCurrentSession(): Promise<CurrentSession> {
        const result = await this.fetch(`/api/auth/session`, { method: 'GET' });
        return await parseJson<CurrentSession>(result);
    }

    /** @name Sign out */
    async logout(): Promise<void> {
        await this.fetch(`/api/auth/logout`, { method: 'POST' });
    }
}
