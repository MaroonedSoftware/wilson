import { Injectable } from 'injectkit';
import { Duration } from 'luxon';
import { isFactorRecent, type ApiKeySessionClaim, type AuthenticationSession } from '@maroonedsoftware/authentication';
import { Policy, type PolicyEnvelope, type PolicyResult } from '@maroonedsoftware/policies';
import { AccountFactors, STRONG_METHODS } from '#modules/authentication/account.factors.js';

/**
 * The route gates (PROJECT.md decision 10). Every gated operation in a contract names one in
 * its `security` block, and the generated router asserts it through `requirePolicy`, which has
 * already answered 401 for a request with no session. What is left to decide is only whether this
 * session may do this kind of thing:
 *
 * - `wilson.view`: read. Any signed-in session, and any API key.
 * - `wilson.manage`: change anything. A signed-in session, or a key with the `manage` scope.
 * - `wilson.step.up`: hand out or rewrite authority. A session that proved a factor within the last
 *   five minutes, never a key (`StepUpPolicy`).
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

export const STEP_UP_POLICY = 'wilson.step.up';

/** How recently a factor must have been proved for a step-up route. deadair's and ats's five minutes. */
export const STEP_UP_WINDOW = Duration.fromObject({ minutes: 5 });

/**
 * `wilson.step.up`: the gate on what hands out or rewrites authority: minting or rotating an API
 * key, saving stage config, and deciding which machine receives card work and engine tokens
 * (registering a host, its SSH target, its worker token, its engine token; PROJECT.md,
 * Authentication: Factors). Everything
 * `wilson.manage` requires, and then a factor the operator proved within {@link STEP_UP_WINDOW}.
 *
 * An API key never satisfies it, whatever its scope: a key is a standing credential, and the point
 * is that a leaked one cannot mint more keys, rewrite the exit conditions stages are judged by
 * (decision 8), or register a worker of its own. The refusal says so (`step_up_unavailable`), and a client answers it by signing in
 * fresh for that one call, as `wilson stages edit` does. A signed-in session that is merely old gets
 * `step_up_required` with the window, and proving a factor again satisfies it. Until a strong
 * factor (an authenticator app, a passkey) is enrolled the password counts; after, only that does.
 */
@Injectable()
export class StepUpPolicy extends ManagePolicy {
    constructor(private readonly factors: AccountFactors) {
        super();
    }

    override async evaluate(context: RequirePolicyContext, envelope: PolicyEnvelope): Promise<PolicyResult> {
        const scoped = await super.evaluate(context, envelope);
        if (!scoped.allowed) return scoped;
        if (keyScopes(context.session) !== undefined) {
            return this.deny('step_up_unavailable', {
                kind: 'step_up_unavailable',
                reason: 'an API key cannot do this; sign in with your password',
            });
        }
        // Once a strong factor is enrolled, the password no longer steps up on its own: otherwise a
        // stolen password would be enough to remove the authenticator that was meant to stop it.
        const accepted = (await this.factors.hasStrongFactor(context.session.subject)) ? STRONG_METHODS : undefined;
        const recent = context.session.factors.some(
            factor =>
                factor.method !== 'apikey' &&
                (accepted === undefined || accepted.includes(factor.method)) &&
                isFactorRecent(factor, envelope.now, STEP_UP_WINDOW),
        );
        if (recent) return this.allow();
        return this.denyStepUp('step_up_required', { within: STEP_UP_WINDOW, ...(accepted ? { acceptableMethods: accepted } : {}) });
    }
}
