import { DateTime } from 'luxon';
import type { PasskeyAssertionCredential } from './passkey.types.js';
import type { PasskeyRequestOptions } from './passkey.types.js';

const __dt = (v: unknown, path: string): DateTime => {
    if (typeof v !== 'string') {
        throw new TypeError(`ContractKit: expected an ISO 8601 string at '${path}', received ${typeof v}.`);
    }
    const d = DateTime.fromISO(v);
    if (!d.isValid) throw new TypeError(`ContractKit: '${v}' at '${path}' is not a valid ISO 8601 datetime.`);
    return d;
};

/**
 * generated from [TokenRequest](../../../../apps/api/data/contracts/auth.ck)
 */
export interface TokenRequest {
    grant_type: 'password' | 'refresh_token' | 'authenticator' | 'passkey';
    /** `password` grant. */
    username?: string;
    password?: string;
    /** `refresh_token` grant. */
    refresh_token?: string;
    /**
     * `authenticator` grant: the second step after a `password` grant answered `mfa_required`.
     * `factor_id` may be left out when only one authenticator is enrolled.
     */
    challenge_id?: string;
    factor_id?: string;
    code?: string;
    /**
     * `passkey` grant: the other second step, with `challenge_id` as above, the passkey challenge
     * `POST /api/auth/passkey/challenge` issued, and the browser's answer to it.
     */
    passkey_challenge_id?: string;
    credential?: PasskeyAssertionCredential;
}

/**
 * A second factor a sign-in may be completed with, as `mfa_required` lists them.
 * generated from [MfaFactor](../../../../apps/api/data/contracts/auth.ck)
 */
export interface MfaFactor {
    method: 'authenticator' | 'passkey';
    id: string;
    label?: string;
}

/**
 * generated from [PasskeyChallengeRequest](../../../../apps/api/data/contracts/auth.ck)
 */
export interface PasskeyChallengeRequest {
    challenge_id: string;
}

/**
 * What to call `navigator.credentials.get` with to complete a sign-in, and the id the `passkey`
 * grant names it by.
 * generated from [PasskeyChallenge](../../../../apps/api/data/contracts/auth.ck)
 */
export interface PasskeyChallenge {
    passkeyChallengeId: string;
    options: PasskeyRequestOptions;
}

/**
 * The session the caller's bearer token names.
 * generated from [CurrentSession](../../../../apps/api/data/contracts/auth.ck)
 */
export interface CurrentSession {
    accountId: string;
    username: string;
    issuedAt: DateTime;
    expiresAt: DateTime;
}

/** Rehydrates every wire-encoded scalar in a CurrentSession into its runtime type. Mutates and returns `raw`. */
export function reviveCurrentSession(raw: CurrentSession): CurrentSession {
    const __o0 = raw as unknown as Record<string, unknown>;
    __o0['issuedAt'] = __dt(__o0['issuedAt'], 'CurrentSession.issuedAt');
    __o0['expiresAt'] = __dt(__o0['expiresAt'], 'CurrentSession.expiresAt');
    return raw;
}

/**
 * A signed-in session. `accessToken` goes in `Authorization: Bearer` on every request, and lasts as
 * long as the session (`expiresIn` seconds) unless the session is revoked first. `refreshToken` is
 * single-use: trading it in returns a new one, and presenting a spent one revokes the session.
 *
 * A caller that sends `x-wilson-cookies: 1` (the web app) gets no `refreshToken` here: it arrives as
 * an httpOnly cookie instead, and a `refresh_token` grant with none in the body redeems that cookie.
 *
 * With a second factor enrolled, a correct password answers `result: mfa_required` instead, with no
 * tokens: `challengeId` and the `factors` to choose from, for an `authenticator` grant to complete
 * within five minutes. Otherwise `result` is `token`.
 * generated from [TokenResponse](../../../../apps/api/data/contracts/auth.ck)
 */
export interface TokenResponse {
    result: 'token' | 'mfa_required';
    accessToken?: string;
    refreshToken?: string;
    expiresIn?: number;
    tokenType?: string;
    challengeId?: string;
    factors?: MfaFactor[];
}
