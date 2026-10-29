import { Injectable } from 'injectkit';
import type { ApiKeySessionClaim, AuthenticationSession } from '@maroonedsoftware/authentication';
import { Policy, type PolicyEnvelope, type PolicyResult } from '@maroonedsoftware/policies';

/**
 * The two route gates (PROJECT.md decision 10). Every gated operation in a contract names one in
 * its `security` block, and the generated router asserts it through `requirePolicy`, which has
 * already answered 401 for a request with no session. What is left to decide is only whether this
 * session may do this kind of thing:
 *
 * - `wilson.view`: read. Any signed-in session, and any API key.
 * - `wilson.manage`: change anything. A signed-in session, or a key with the `manage` scope.
 *
 * There is one account, so there is no "whose board" question; a signed-in session is the operator
 * and may do anything a route allows. Scopes are what narrows a key.
 */
export const VIEW_POLICY = 'wilson.view';
export const MANAGE_POLICY = 'wilson.manage';

/** What `requirePolicy` hands every policy: the request's session. */
export interface RequirePolicyContext {
    session: AuthenticationSession;
}

/** The scopes of the key a session came from, or `undefined` for a signed-in session. */
const keyScopes = (session: AuthenticationSession): readonly string[] | undefined =>
    (session.claims.apiKey as ApiKeySessionClaim | undefined)?.scopes;

/** Refuse a key that lacks `scope`, with the challenge RFC 6750 defines for exactly this. */
abstract class ScopedPolicy extends Policy<RequirePolicyContext> {
    protected abstract readonly accepted: readonly string[];
    protected abstract readonly scope: string;

    async evaluate(context: RequirePolicyContext, _envelope: PolicyEnvelope): Promise<PolicyResult> {
        const scopes = keyScopes(context.session);
        if (scopes === undefined || scopes.some(scope => this.accepted.includes(scope))) return this.allow();
        return this.deny('insufficient_scope', { scope: this.scope }).withHeaders({
            'WWW-Authenticate': `Bearer error="insufficient_scope", scope="${this.scope}"`,
        });
    }
}

@Injectable()
export class ViewPolicy extends ScopedPolicy {
    protected readonly accepted = ['view', 'manage'];
    protected readonly scope = 'view';
}

@Injectable()
export class ManagePolicy extends ScopedPolicy {
    protected readonly accepted = ['manage'];
    protected readonly scope = 'manage';
}
