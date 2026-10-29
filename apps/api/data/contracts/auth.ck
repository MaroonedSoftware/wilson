options {
    services: {
        TokenService: "#modules/authentication/token.service.js"
        CurrentSessionService: "#modules/authentication/current.session.service.js"
    }
    security: none
}

# Signing in (PROJECT.md, Authentication). Every way of getting a session goes through
# `POST /api/auth/token` with a `grant_type`, the OAuth shape deadair and ats use: `password` signs in
# (or, with a second factor enrolled, starts signing in), `authenticator` or `passkey` finishes it,
# and `refresh_token` trades a refresh token for a fresh pair. The request
# field names are OAuth's (`grant_type`, `refresh_token`) except `email`, where OAuth says
# `username`: the account signs in with an email address, and the field says so. The response's
# names are this API's own.
#
# `security: none` on `token` and `logout`: signing in is how a caller gets a session, and signing
# out must work with a dead one. `session` needs one (`wilson.view`).

contract TokenRequest: {
    grant_type: enum(password, refresh_token, authenticator, passkey)
    # `password` grant.
    email?: email
    password?: string(max=256)
    # `refresh_token` grant.
    refresh_token?: string
    # `authenticator` grant: the second step after a `password` grant answered `mfa_required`.
    # `factor_id` may be left out when only one authenticator is enrolled.
    challenge_id?: string
    factor_id?: string
    code?: string(max=10)
    # `passkey` grant: the other second step, with `challenge_id` as above, the passkey challenge
    # `POST /api/auth/passkey/challenge` issued, and the browser's answer to it.
    passkey_challenge_id?: string
    credential?: PasskeyAssertionCredential
}

# A second factor a sign-in may be completed with, as `mfa_required` lists them.
contract MfaFactor: {
    method: enum(authenticator, passkey)
    id: string
    label?: string
}

# A signed-in session. `accessToken` goes in `Authorization: Bearer` on every request, and lasts as
# long as the session (`expiresIn` seconds) unless the session is revoked first. `refreshToken` is
# single-use: trading it in returns a new one, and presenting a spent one revokes the session.
#
# A caller that sends `x-wilson-cookies: 1` (the web app) gets no `refreshToken` here: it arrives as
# an httpOnly cookie instead, and a `refresh_token` grant with none in the body redeems that cookie.
#
# With a second factor enrolled, a correct password answers `result: mfa_required` instead, with no
# tokens: `challengeId` and the `factors` to choose from, for an `authenticator` grant to complete
# within five minutes. Otherwise `result` is `token`.
contract TokenResponse: {
    result: enum(token, mfa_required)
    accessToken?: string
    refreshToken?: string
    expiresIn?: number
    tokenType?: string
    challengeId?: string
    factors?: array(MfaFactor)
}

contract PasskeyChallengeRequest: {
    challenge_id: string
}

# What to call `navigator.credentials.get` with to complete a sign-in, and the id the `passkey`
# grant names it by.
contract PasskeyChallenge: {
    passkeyChallengeId: string
    options: PasskeyRequestOptions
}

# The session the caller's bearer token names.
contract CurrentSession: {
    accountId: string
    email: email
    issuedAt: datetime
    expiresAt: datetime
}

operation /api/auth/token: {
    post: {
        name: Sign in
        mcp: exclude # Signing in is for people and their clients, not an agent
        sdk: requestToken
        service: TokenService.requestToken
        request: {
            application/json: TokenRequest
        }
        response: {
            200: {
                application/json: TokenResponse
            }
            # The grant's fields are missing.
            400:
            # Wrong email, password or code, a challenge that expired, or a refresh token that is
            # invalid, spent or revoked.
            401:
            # Too many wrong passwords or codes. Wait five minutes.
            429:
        }
    }
}

# The passkey half of the second step: a challenge for the browser to sign, issued against the
# sign-in the password started. `security: none`, like `token`: the pending sign-in's challenge is
# what authorizes it, and it is good for one sign-in.
operation /api/auth/passkey/challenge: {
    post: {
        name: Start a passkey sign-in step
        mcp: exclude # Signing in is for people and their clients, not an agent
        sdk: startPasskeyChallenge
        service: TokenService.startPasskeyChallenge
        request: {
            application/json: PasskeyChallengeRequest
        }
        response: {
            200: {
                application/json: PasskeyChallenge
            }
            # Not from the web app.
            400:
            # The sign-in challenge expired or was never issued.
            401:
        }
    }
}

operation /api/auth/session: {
    get: {
        name: Get the current session
        mcp: exclude # Signing in is for people and their clients, not an agent
        sdk: getCurrentSession
        service: CurrentSessionService.get
        security: {
            policy: wilson.view
        }
        response: {
            200: {
                application/json: CurrentSession
            }
            # No bearer token, or one whose session has ended.
            401:
        }
    }
}

operation /api/auth/logout: {
    post: {
        name: Sign out
        mcp: exclude # Signing in is for people and their clients, not an agent
        sdk: logout
        service: CurrentSessionService.logout
        response: {
            # Signed out, or there was no session to end. Either way, the caller's tokens no longer
            # work.
            204:
        }
    }
}
