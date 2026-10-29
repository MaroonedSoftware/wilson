import { SdkError, type SdkFetch, type SdkRequestInit } from '@wilson/sdk';

/**
 * The web app's sign-in state (PROJECT.md, Authentication: Transport).
 *
 * The access token lives here, in memory and nowhere else: not localStorage, which any script on
 * the page could read. A reload forgets it, and `restoreSession` gets a new one from the httpOnly
 * refresh cookie the API set at sign-in, which no script can read at all. Every request sends
 * `x-wilson-cookies: 1`, so the API answers sign-in and refresh with cookies rather than putting
 * the refresh token in the body.
 */
let accessToken: string | undefined;
const listeners = new Set<() => void>();

const notify = () => listeners.forEach(listener => listener());

export const currentAccessToken = (): string | undefined => accessToken;

export const setAccessToken = (token: string | undefined): void => {
    accessToken = token;
    notify();
};

/** Called whenever the token changes, including when a refresh fails and it is dropped. */
export const onSessionChange = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
};

/**
 * Asks the operator to confirm it is them (`StepUpDialog`), resolving true once a fresh session is
 * in place and false if they cancel. Registered by the dialog while it is mounted.
 */
let stepUpHandler: (() => Promise<boolean>) | undefined;

export const setStepUpHandler = (handler: (() => Promise<boolean>) | undefined): void => {
    stepUpHandler = handler;
};

/** Whether a response is the API asking for a recently proved factor (`wilson.step.up`). */
const needsStepUp = async (res: Response): Promise<boolean> => {
    if (res.status !== 403) return false;
    try {
        return ((await res.clone().json()) as { details?: { kind?: string } }).details?.kind === 'step_up_required';
    } catch {
        return false;
    }
};

/** Sent on every request so the API uses cookies for this client; see `session.cookies.ts` in apps/api. */
const COOKIE_OPT_IN = { 'x-wilson-cookies': '1' };

const TOKEN_PATH = '/api/auth/token';

let refreshing: Promise<boolean> | undefined;

/**
 * Trade the refresh cookie for a fresh access token, once at a time: concurrent 401s share one
 * refresh, because the refresh token is single-use and a second concurrent redemption would be taken
 * as a replay and end the session.
 */
export const refreshSession = (baseUrl: string): Promise<boolean> => {
    refreshing ??= (async () => {
        try {
            const res = await fetch(`${baseUrl}${TOKEN_PATH}`, {
                method: 'POST',
                credentials: 'include',
                headers: { 'content-type': 'application/json', ...COOKIE_OPT_IN },
                body: JSON.stringify({ grant_type: 'refresh_token' }),
            });
            if (!res.ok) {
                setAccessToken(undefined);
                return false;
            }
            setAccessToken(((await res.json()) as { accessToken: string }).accessToken);
            return true;
        } catch {
            // Unreachable: keep whatever token there was, and let the caller's request fail on its own.
            return false;
        } finally {
            refreshing = undefined;
        }
    })();
    return refreshing;
};

/**
 * The SDK's fetch for the web app: `createSdkFetch` (packages/sdk) plus the session.
 *
 * Adds the bearer token and the cookie opt-in, sends credentials so the API's cookies travel, and
 * on a 401 refreshes once and replays the request. A request to the token endpoint itself is never
 * replayed, so a wrong password is a 401 the sign-in form sees rather than a refresh attempt.
 *
 * A 403 asking for a step-up (adding or removing a second factor with a session older than five
 * minutes) opens the step-up dialog, and once the operator has signed in again the request is
 * replayed with the new session.
 */
export const sessionFetch = (options: { baseUrl: string; headers?: Record<string, string> }): SdkFetch => {
    const send = (url: string, init: SdkRequestInit) =>
        fetch(`${options.baseUrl}${url}`, {
            ...init,
            credentials: 'include',
            headers: {
                ...options.headers,
                ...COOKIE_OPT_IN,
                ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
                'X-Request-ID': crypto.randomUUID(),
                ...(init.headers as Record<string, string> | undefined),
            },
        });

    return async (url, init) => {
        let res = await send(url, init);
        if (res.status === 401 && !url.startsWith(TOKEN_PATH) && (await refreshSession(options.baseUrl))) {
            res = await send(url, init);
        }
        if (stepUpHandler && (await needsStepUp(res)) && (await stepUpHandler())) {
            res = await send(url, init);
        }
        if (!res.ok && !(init.expectStatuses ?? []).includes(res.status)) {
            const text = await res.text();
            let body: unknown;
            try {
                body = JSON.parse(text);
            } catch {
                body = text;
            }
            throw new SdkError(res.status, res.statusText, body, res.headers);
        }
        return res;
    };
};
