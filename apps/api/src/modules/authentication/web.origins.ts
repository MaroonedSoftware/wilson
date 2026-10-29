import type { AppConfig } from '@maroonedsoftware/appconfig';
import { optionalConfigString } from '#shared/require.config.js';

/** Where the web app is served from in development: `apps/web`'s Vite port. */
export const DEFAULT_WEB_ORIGIN = 'http://localhost:13101';

/**
 * The browser origins the web app is served from: `WEB_ORIGINS`, comma-separated, or the dev web
 * app alone. Exact origins, never a pattern. Two things trust this list and nothing wider: CORS with
 * credentials (`setup.middleware.ts`), since the refresh cookie is redeemable by any origin CORS
 * admits, and passkeys (`PasskeyRelyingParty`), since a passkey is bound to the origin it was made
 * at and a page elsewhere must never be handed a challenge one of ours would answer.
 */
export const webOrigins = (config: AppConfig): string[] =>
    (optionalConfigString(config, 'WEB_ORIGINS') ?? DEFAULT_WEB_ORIGIN)
        .split(',')
        .map(origin => origin.trim().replace(/\/$/, ''))
        .filter(origin => origin.length > 0);

/** {@link webOrigins}, as a DI value for services that need it per request. */
export class WebOrigins {
    constructor(readonly origins: readonly string[]) {}
}
