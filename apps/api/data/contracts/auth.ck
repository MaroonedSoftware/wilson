options {
    services: {
        TokenService: "#modules/authentication/token.service.js"
        CurrentSessionService: "#modules/authentication/current.session.service.js"
    }
    security: none
}

# Signing in (PROJECT.md, Authentication). Every way of getting a session goes through
# `POST /api/auth/token` with a `grant_type`, the OAuth shape deadair and ats use. Two grants exist so
# far: `password` signs in, and `refresh_token` trades a refresh token for a fresh pair. The request
# field names are OAuth's (`grant_type`, `refresh_token`); the response's are this API's own.
#
# `security: none` on `token` is permanent: signing in is how a caller gets a session. On `session`
# and `logout` it is for now. They read the caller's bearer token themselves and answer 401 without
# one, and rollout step 6 replaces that with the same gate every other route gets.

contract TokenRequest: {
    grant_type: enum(password, refresh_token)
    # `password` grant.
    username?: string(max=64)
    password?: string(max=256)
    # `refresh_token` grant.
    refresh_token?: string
}

# A signed-in session. `accessToken` goes in `Authorization: Bearer` on every request, and lasts as
# long as the session (`expiresIn` seconds) unless the session is revoked first. `refreshToken` is
# single-use: trading it in returns a new one, and presenting a spent one revokes the session.
contract TokenResponse: {
    accessToken: string
    refreshToken: string
    expiresIn: number
    tokenType: string
}

# The session the caller's bearer token names.
contract CurrentSession: {
    accountId: string
    username: string
    issuedAt: datetime
    expiresAt: datetime
}

operation /api/auth/token: {
    post: {
        name: Sign in
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
            # Wrong username or password, or a refresh token that is invalid, spent or revoked.
            401:
            # Too many wrong passwords. Wait five minutes.
            429:
        }
    }
}

operation /api/auth/session: {
    get: {
        name: Get the current session
        sdk: getCurrentSession
        service: CurrentSessionService.get
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
        sdk: logout
        service: CurrentSessionService.logout
        response: {
            # Signed out, or there was no session to end. Either way, the caller's tokens no longer
            # work.
            204:
        }
    }
}
