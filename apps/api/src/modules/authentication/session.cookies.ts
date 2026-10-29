import type { ServerKitContext } from '@maroonedsoftware/koa';
import { SESSION_LIFETIME } from './session.options.js';

/**
 * The web app's two cookies (PROJECT.md, Authentication: Transport). Both httpOnly, so script on the
 * page cannot read them, and SameSite=Strict, so no other site's page can make the browser send
 * them. The web app and the API are on one host (ports differ, sites do not), so Strict still lets
 * the web app's own requests carry them.
 *
 * - `wilson_rt`, the refresh token, scoped to `/api/auth`: only `POST /api/auth/token` and
 *   `POST /api/auth/logout` ever receive it. This is how a reload stays signed in without the token
 *   being readable by script.
 * - `wilson_at`, the access token, accepted only by the two read-only event streams, where the
 *   browser's `EventSource` cannot send an `Authorization` header (`streamCookieMiddleware`). Every
 *   other route ignores it and requires the bearer header, so a cookie the browser attaches on its
 *   own can read a stream and do nothing else.
 *
 * A client opts in with `x-wilson-cookies: 1`. The CLI and scripts never send it, and get the
 * refresh token in the response body instead, as before.
 */
export const REFRESH_COOKIE = 'wilson_rt';
export const STREAM_COOKIE = 'wilson_at';
export const COOKIE_OPT_IN_HEADER = 'x-wilson-cookies';

const REFRESH_COOKIE_PATH = '/api/auth';
const STREAM_COOKIE_PATH = '/api';

export const wantsCookies = (ctx: ServerKitContext): boolean => ctx.get(COOKIE_OPT_IN_HEADER) === '1';

const base = (ctx: ServerKitContext) => ({ httpOnly: true, sameSite: 'strict' as const, secure: ctx.secure, overwrite: true });

/** Set both cookies for a freshly issued or refreshed session. */
export const setSessionCookies = (ctx: ServerKitContext, tokens: { accessToken: string; refreshToken: string; expiresIn: number }): void => {
    ctx.cookies.set(REFRESH_COOKIE, tokens.refreshToken, { ...base(ctx), path: REFRESH_COOKIE_PATH, maxAge: SESSION_LIFETIME.as('milliseconds') });
    ctx.cookies.set(STREAM_COOKIE, tokens.accessToken, { ...base(ctx), path: STREAM_COOKIE_PATH, maxAge: tokens.expiresIn * 1000 });
};

/** Expire both cookies: on sign-out, and when a refresh cookie proves dead. */
export const clearSessionCookies = (ctx: ServerKitContext): void => {
    ctx.cookies.set(REFRESH_COOKIE, null, { ...base(ctx), path: REFRESH_COOKIE_PATH });
    ctx.cookies.set(STREAM_COOKIE, null, { ...base(ctx), path: STREAM_COOKIE_PATH });
};

export const refreshCookieOf = (ctx: ServerKitContext): string | undefined => ctx.cookies.get(REFRESH_COOKIE) || undefined;
