import { Injectable } from 'injectkit';
import type { ApiKeyAllowedPolicyContext } from '@maroonedsoftware/authentication';
import { Policy, type PolicyEnvelope, type PolicyResult } from '@maroonedsoftware/policies';
import { AccountRepository } from './account.repository.js';

/**
 * `auth.api.key.allowed`, which `ApiKeyService` asks when a key is created and every time one is
 * used. A key works only while its owner's account is active.
 *
 * This is the account check `WilsonJwtAuthenticationIssuer` makes for signed-in sessions, on the
 * key path. A key's session is built fresh per request from the key row and never stored, so the
 * issuer never sees it; without this, a key would outlive the account it was minted for.
 */
@Injectable()
export class AccountApiKeyAllowedPolicy extends Policy<ApiKeyAllowedPolicyContext> {
    constructor(private readonly accounts: AccountRepository) {
        super();
    }

    async evaluate(context: ApiKeyAllowedPolicyContext, _envelope: PolicyEnvelope): Promise<PolicyResult> {
        if (await this.accounts.existsActive(context.owner.actorId)) return this.allow();
        return this.deny('account_inactive');
    }
}
