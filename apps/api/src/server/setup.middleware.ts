import type { Container } from 'injectkit';
import { corsMiddleware, errorMiddleware, serverKitContextMiddleware, type ServerKitMiddleware } from '@maroonedsoftware/koa';

/**
 * The minimal middleware stack for a single-operator, self-hosted server (PROJECT.md non-goals):
 * no authentication, no rate limiting, no CORS beyond localhost.
 *
 * Order matters — `errorMiddleware` must run first so it can catch everything downstream, and
 * `serverKitContextMiddleware` must run second so later middleware and every route handler has
 * `ctx.container` and `ctx.logger`.
 */
export const setupMiddleware = (container: Container): ServerKitMiddleware[] => [
    errorMiddleware(),
    serverKitContextMiddleware(container),
    corsMiddleware({ origin: [/^http:\/\/localhost(:\d+)?$/] }),
];
