import { AuditSink, type ApiKeySessionClaim, type AuthenticationAuditEvent, type AuthenticationSession } from '@maroonedsoftware/authentication';

const listeners = new Map<string, Set<() => void>>();

const sessionKey = (sessionToken: string) => `session:${sessionToken}`;
const apiKeyKey = (id: string) => `key:${id}`;

/** What ends a session: its own token, or for a key's unpersisted session, that key's id. */
const keyFor = (session: AuthenticationSession): string => {
    const apiKey = session.claims.apiKey as ApiKeySessionClaim | undefined;
    return apiKey ? apiKeyKey(apiKey.id) : sessionKey(session.sessionToken);
};

const publish = (key: string): void => {
    for (const listener of [...(listeners.get(key) ?? [])]) listener();
};

/**
 * Call `listener` when the credential behind `session` stops working, returning the unsubscribe.
 *
 * For what outlives the request that authenticated it. Every ordinary request resolves its token
 * afresh, so a revoked one fails on its next request, but an event stream is one request that never
 * ends, and without this it would keep delivering after sign-out (`routes.setup.ts`).
 *
 * In this process's memory, like `card.feed.ts`: only the API process serves streams and revokes.
 */
export const onCredentialRevoked = (session: AuthenticationSession, listener: () => void): (() => void) => {
    const key = keyFor(session);
    const subscribed = listeners.get(key) ?? new Set();
    listeners.set(key, subscribed);
    subscribed.add(listener);
    return () => {
        subscribed.delete(listener);
        if (subscribed.size === 0 && listeners.get(key) === subscribed) listeners.delete(key);
    };
};

/**
 * Hears revocations from the library's audit events, which is the one place every path reports
 * them: sign-out, a replayed refresh token revoking its family, an account switched off, and
 * revoking, rotating or deleting a key. Rotating counts because the old secret stops working at once.
 */
export class CredentialRevocationSink extends AuditSink {
    record(event: AuthenticationAuditEvent): void {
        if (!event.data) return;
        switch (event.type) {
            case 'session.revoked':
                publish(sessionKey(event.data.sessionToken));
                break;
            case 'api_key.revoked':
            case 'api_key.rotated':
            case 'api_key.deleted':
                publish(apiKeyKey(event.data.id));
                break;
        }
    }
}
