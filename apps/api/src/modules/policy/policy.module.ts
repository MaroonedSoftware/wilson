import { Container, Injectable, Registry, type Constructor } from 'injectkit';
import { DateTime } from 'luxon';
import type { AppConfig } from '@maroonedsoftware/appconfig';
import { PasswordAllowedPolicy, type ApiKeyAllowedPolicyContext, type PasswordAllowedPolicyContext } from '@maroonedsoftware/authentication';
import { ServerKitModule } from '@maroonedsoftware/koa';
import { AccountApiKeyAllowedPolicy } from '#modules/authentication/api.key.allowed.policy.js';
import { BasePolicyService, PolicyRegistryMap, PolicyService, type Policy, type PolicyEnvelope } from '@maroonedsoftware/policies';

/**
 * Every policy wilson can be asked to evaluate, by name. `@maroonedsoftware/authentication` asks for
 * these by name from inside its own services, so a name it uses and this map lacks fails at the
 * first call that needs it, not at boot. deadair's `policy.mappings.ts` is the full list; entries
 * join this one as the rollout reaches the services that ask for them.
 */
export const POLICY_MAPPINGS = {
    // Asked by `PasswordFactorService` before it stores a password: zxcvbn strength, and no reuse of
    // a previous password.
    'auth.factor.password.allowed': PasswordAllowedPolicy,
    // Asked by `ApiKeyService` when a key is created and whenever one is used.
    'auth.api.key.allowed': AccountApiKeyAllowedPolicy,
} as const;

export interface WilsonPolicyContexts {
    'auth.factor.password.allowed': PasswordAllowedPolicyContext;
    'auth.api.key.allowed': ApiKeyAllowedPolicyContext;
}

/**
 * `PolicyService` with the envelope every policy is evaluated in. Only the time, for now: deadair's
 * also carries the acting principal, which arrives with request authentication (rollout step 6).
 */
@Injectable()
export class WilsonPolicyService extends BasePolicyService<WilsonPolicyContexts> {
    constructor(container: Container, policyRegistry: PolicyRegistryMap) {
        super(container, policyRegistry);
    }

    protected async buildEnvelope(): Promise<PolicyEnvelope> {
        return { now: DateTime.utc() };
    }
}

export const PolicyModule: ServerKitModule = {
    name: 'Policy',
    setup: async (registry: Registry, _: AppConfig) => {
        const policies = new PolicyRegistryMap();
        for (const [name, policy] of Object.entries(POLICY_MAPPINGS) as [string, Constructor<Policy>][]) {
            policies.set(name, policy);
            registry.register(policy).useClass(policy).asTransient();
        }
        registry.register(PolicyRegistryMap).useInstance(policies);
        registry.register(PolicyService).useClass(WilsonPolicyService).asTransient();
    },
};
