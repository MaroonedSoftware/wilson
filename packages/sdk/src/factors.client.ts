import type { AuthenticatorRegistration, SecondFactorSummary, StartAuthenticatorRequest, VerifyAuthenticatorRequest } from './types/factors.js';
import type { SdkFetch } from './sdk-options.js';
import { bigIntReplacer, parseJson } from './sdk-options.js';

/**
 * generated from [factors.ck](file://./../../../apps/api/data/contracts/factors.ck)
 */
export class FactorsClient {
    constructor(private fetch: SdkFetch) {}

    /** @name List second factors */
    async listSecondFactors(): Promise<SecondFactorSummary[]> {
        const result = await this.fetch(`/api/auth/factors`, { method: 'GET' });
        return await parseJson<SecondFactorSummary[]>(result);
    }

    /** @name Start enrolling an authenticator app */
    async startAuthenticator(body: StartAuthenticatorRequest): Promise<AuthenticatorRegistration> {
        const result = await this.fetch(`/api/auth/factors/authenticator`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return await parseJson<AuthenticatorRegistration>(result);
    }

    /** @name Finish enrolling an authenticator app */
    async verifyAuthenticator(body: VerifyAuthenticatorRequest): Promise<SecondFactorSummary> {
        const result = await this.fetch(`/api/auth/factors/authenticator/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return await parseJson<SecondFactorSummary>(result);
    }

    /** @name Remove a second factor */
    async removeSecondFactor(id: string): Promise<void> {
        await this.fetch(`/api/auth/factors/${encodeURIComponent(id)}`, { method: 'DELETE' });
    }
}
