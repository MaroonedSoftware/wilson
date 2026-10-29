import type { CreateAccountRequest, OnboardingStatus } from './types/onboarding.js';
import type { SdkFetch } from './sdk-options.js';
import { bigIntReplacer, parseJson } from './sdk-options.js';

/**
 * generated from [onboarding.ck](file://./../../../apps/api/data/contracts/onboarding.ck)
 */
export class OnboardingClient {
    constructor(private fetch: SdkFetch) {}

    /** @name Get onboarding status */
    async getOnboardingStatus(): Promise<OnboardingStatus> {
        const result = await this.fetch(`/api/onboarding`, { method: 'GET' });
        return await parseJson<OnboardingStatus>(result);
    }

    /** @name Create the operator account */
    async createAccount(body: CreateAccountRequest): Promise<OnboardingStatus> {
        const result = await this.fetch(`/api/onboarding`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return await parseJson<OnboardingStatus>(result);
    }
}
