import type { Container } from 'injectkit';
import {
    authenticationMiddleware,
    corsMiddleware,
    errorMiddleware,
    serverKitContextMiddleware,
    type ServerKitMiddleware,
} from '@maroonedsoftware/koa';

/**
 * The middleware stack for a single-operator, self-hosted server: no rate limiting, no CORS beyond
 * localhost.
 *
 * Order matters — `errorMiddleware` must run first so it can catch everything downstream, and
 * `serverKitContextMiddleware` must run second so later middleware and every route handler has
 * `ctx.container` and `ctx.logger`.
 *
 * `authenticationMiddleware` resolves the caller's bearer token into `ctx.authenticationSession`
 * (PROJECT.md, Authentication), leaving the sentinel `invalidAuthenticationSession` when there is
 * no token or it is dead. It refuses nobody: until rollout step 6 gates the routes, a request with
 * no token reaches every route exactly as before. It also strips `Authorization` from the request,
 * so nothing downstream can log the token.
 */
export const setupMiddleware = (container: Container): ServerKitMiddleware[] => [
    errorMiddleware(),
    serverKitContextMiddleware(container),
    corsMiddleware({ origin: [/^http:\/\/localhost(:\d+)?$/] }),
    authenticationMiddleware(),
];
