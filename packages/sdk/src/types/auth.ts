/**
 * generated from [TokenRequest](file://./../../../../apps/api/data/contracts/auth.ck#L18)
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
 * generated from [TokenResponse](file://./../../../../apps/api/data/contracts/auth.ck#L30)
 */
export interface TokenResponse {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    tokenType: string;
}

/**
 * The session the caller's bearer token names.
 * generated from [CurrentSession](file://./../../../../apps/api/data/contracts/auth.ck#L38)
 */
export interface CurrentSession {
    accountId: string;
    username: string;
    issuedAt: string;
    expiresAt: string;
}
