import type { Container } from 'injectkit';
import type { AppConfig } from '@maroonedsoftware/appconfig';
import {
    authenticationMiddleware,
    corsMiddleware,
    errorMiddleware,
    serverKitContextMiddleware,
    type ServerKitMiddleware,
} from '@maroonedsoftware/koa';
import { webOrigins } from '#modules/authentication/web.origins.js';
import { streamCookieMiddleware } from './stream.cookie.middleware.js';

/**
 * The middleware stack for a single-operator, self-hosted server: no rate limiting beyond the
 * password limiter, CORS for the web app's origins only.
 *
 * Order matters — `errorMiddleware` must run first so it can catch everything downstream, and
 * `serverKitContextMiddleware` must run second so later middleware and every route handler has
 * `ctx.container` and `ctx.logger`.
 *
 * `authenticationMiddleware` resolves the caller's bearer token into `ctx.authenticationSession`
 * (PROJECT.md, Authentication), leaving the sentinel `invalidAuthenticationSession` when there is
 * no token or it is dead. It refuses nobody: a route that needs a session refuses the sentinel
 * itself. It also strips `Authorization` from the request, so nothing downstream can log the token.
 * `streamCookieMiddleware` runs just before it, so the event streams can authenticate by cookie.
 */
export const setupMiddleware =
    (config: AppConfig) =>
    (container: Container): ServerKitMiddleware[] => [
        errorMiddleware(),
        serverKitContextMiddleware(container),
        corsMiddleware({ origin: webOrigins(config), credentials: true }),
        streamCookieMiddleware(),
        authenticationMiddleware(),
    ];
