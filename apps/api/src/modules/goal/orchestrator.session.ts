import type { AuthenticationSession } from '@maroonedsoftware/authentication';
import { DateTime, Duration } from 'luxon';

/** Who a wake-up's operations are attributed to. No account has this as its subject. */
export const ORCHESTRATOR_SUBJECT = 'orchestrator';

/** Long enough for any one turn. A session is built per wake-up, and never stored. */
const LIFETIME = Duration.fromObject({ hours: 1 });

/**
 * The session a wake-up runs as: nobody asked for the turn, so it cannot run as anybody.
 *
 * Holds the claim a `view` API key's session holds (`access.policies.ts`), so `wilson.view` allows it,
 * and `wilson.manage` and `wilson.step.up` refuse it, whatever the turn's prompt or the text it read
 * says. A change the turn wants is proposed, and runs later as the person who confirms it. It is built
 * in process and never issued, so no request can present it.
 */
export const orchestratorSession = (): AuthenticationSession => {
    const now = DateTime.now();
    return {
        subject: ORCHESTRATOR_SUBJECT,
        sessionToken: `orchestrator-${now.toMillis()}`,
        issuedAt: now,
        lastAccessedAt: now,
        expiresAt: now.plus(LIFETIME),
        factors: [],
        claims: { apiKey: { scopes: ['view'] } },
    };
};
