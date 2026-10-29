import { httpError } from '@maroonedsoftware/errors';
import type { ServerKitContext } from '@maroonedsoftware/koa';
import type { WebOrigins } from './web.origins.js';

/** Who a passkey is bound to, in the terms WebAuthn asks for: the host, and the full origin. */
export interface RelyingParty {
    rpId: string;
    rpOrigin: string;
}

export const RELYING_PARTY_NAME = 'wilson';

/**
 * The relying party for this request: the web app's origin, as the browser asking sends it, and
 * only if it is one of `WEB_ORIGINS` (deadair's `PasskeyRelyingParty`, narrowed to wilson's one
 * list). A self-hosted wilson has no fixed domain, so this cannot be configured once; reading the
 * `Origin` is safe only because it is then held to the exact origins the operator configured.
 * Echoing any origin back would hand a page elsewhere a challenge one of our passkeys would answer,
 * which is the one attack passkeys exist to stop.
 *
 * The CLI sends no `Origin`, and gets a 400 saying passkeys are for the web app.
 */
export const relyingPartyFor = (context: ServerKitContext, allowed: WebOrigins): RelyingParty => {
    const header = context.get('origin');
    let origin: URL | undefined;
    try {
        origin = header ? new URL(header) : undefined;
    } catch {
        origin = undefined;
    }
    if (!origin || !allowed.origins.includes(origin.origin)) {
        throw httpError(400).withDetails({ reason: 'passkeys work only in the web app, at an address in WEB_ORIGINS' });
    }
    return { rpId: origin.hostname, rpOrigin: origin.origin };
};
