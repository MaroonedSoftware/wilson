/**
 * generated from [TokenRequest](file://./../../../../apps/api/data/contracts/auth.ck#L17)
 */
export interface TokenRequest {
    grant_type: 'password' | 'refresh_token';
    /** `password` grant. */
    username?: string;
    password?: string;
    /** `refresh_token` grant. */
    refresh_token?: string;
}

/**
 * A signed-in session. `accessToken` goes in `Authorization: Bearer` on every request, and lasts as
 * long as the session (`expiresIn` seconds) unless the session is revoked first. `refreshToken` is
 * single-use: trading it in returns a new one, and presenting a spent one revokes the session.
 *
 * A caller that sends `x-wilson-cookies: 1` (the web app) gets no `refreshToken` here: it arrives as
 * an httpOnly cookie instead, and a `refresh_token` grant with none in the body redeems that cookie.
 * generated from [TokenResponse](file://./../../../../apps/api/data/contracts/auth.ck#L32)
 */
export interface TokenResponse {
    accessToken: string;
    refreshToken?: string;
    expiresIn: number;
    tokenType: string;
}

/**
 * The session the caller's bearer token names.
 * generated from [CurrentSession](file://./../../../../apps/api/data/contracts/auth.ck#L40)
 */
export interface CurrentSession {
    accountId: string;
    username: string;
    issuedAt: string;
    expiresAt: string;
}
