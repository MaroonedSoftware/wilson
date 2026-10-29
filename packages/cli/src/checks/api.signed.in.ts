import type { Check } from '@maroonedsoftware/johnny5';
import { SdkError } from '@wilson/sdk';
import { apiClient, resolveApiBase } from '../api-client.js';

/**
 * This machine can call the API (PROJECT.md decision 10). Every route but a few public ones needs a
 * credential, so a CLI with no key, or a revoked one, answers every board command with "not signed
 * in"; this says so once, up front, with the fix.
 *
 * An unreachable API passes: whether the daemon is up is `daemon not stale`'s business, and this
 * check has nothing to say about a server it cannot ask.
 */
export const apiSignedIn: Check = {
    name: 'signed in to the API',
    run: async ctx => {
        try {
            const session = await apiClient(ctx).auth.getCurrentSession();
            return { ok: true, message: `signed in to ${resolveApiBase(ctx)} as ${session.email}` };
        } catch (err) {
            if (err instanceof SdkError && err.status === 401) {
                return {
                    ok: false,
                    message: `not signed in to ${resolveApiBase(ctx)}`,
                    fixHint: 'Run `wilson auth login`, or set WILSON_API_KEY to a key made with it.',
                };
            }
            return { ok: true, message: 'API not reachable; skipped' };
        }
    },
};
