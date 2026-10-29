import { Duration } from 'luxon';

/** The `iss` and `aud` of every session token, so a token minted by another ServerKit app (deadair,
 * ats) that happened to share a key would still be refused here. */
export const SESSION_ISSUER = 'wilson';

/** How long a session lives, and so how long an access token naming it does: deadair's thirty days.
 * Revocation does not wait for it, since every token is checked against its session on use. */
export const SESSION_LIFETIME = Duration.fromObject({ days: 30 });

/** API keys are `wl_` plus a random body and a checksum. */
export const API_KEY_PREFIX = 'wl';

/** How often a key's `last_used_at` is written: at most once per window, not on every request. */
export const API_KEY_USE_WINDOW = Duration.fromObject({ minutes: 5 });
