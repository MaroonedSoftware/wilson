import type { ServerKitMiddleware } from '@maroonedsoftware/koa';
import { STREAM_COOKIE } from '#modules/authentication/session.cookies.js';

/** The two event streams: the board feed and a card's planning conversation. */
const STREAM_PATHS = [/^\/api\/feed$/, /^\/api\/cards\/[^/]+\/plan\/stream$/];

/**
 * Lets the web app's `EventSource` authenticate. The browser's `EventSource` cannot set headers, so
 * on the two read-only stream routes, and only there, a request with no `Authorization` header but
 * the `wilson_at` cookie is treated as if it had sent that token as a bearer. It runs ahead of
 * `authenticationMiddleware`, which then resolves the session exactly as for a header.
 *
 * GET only, and only these paths: everywhere else the cookie is ignored, so a request the browser
 * attaches it to on its own can read a stream and change nothing (`session.cookies.ts`).
 */
export const streamCookieMiddleware = (): ServerKitMiddleware => async (ctx, next) => {
    if (ctx.method === 'GET' && !ctx.req.headers.authorization && STREAM_PATHS.some(path => path.test(ctx.path))) {
        const token = ctx.cookies.get(STREAM_COOKIE);
        if (token) ctx.req.headers.authorization = `Bearer ${token}`;
    }
    await next();
};
