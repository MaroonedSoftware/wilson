options {
    services: {
        ApiKeysService: "#modules/authentication/api.keys.service.js"
    }
    security: none
}

# The operator's API keys (PROJECT.md, Authentication): what the CLI and scripts send as
# `Authorization: Bearer wl_...`. The token is shown once, when a key is created or rotated, and only
# its hash is kept.
#
# `security: none` until rollout step 6, like `auth.ck`'s session routes: each operation reads the
# caller's session itself and answers 401 without one. A key can list keys and revoke one, but only
# a signed-in session can create or rotate one (403 otherwise).

# What a key may do. `manage` includes `view`.
contract ApiKeyScope: enum(view, manage)

# A key as the list shows it. `hint` is the last few characters of the token, to tell keys apart.
contract ApiKeySummary: {
    id: string
    name: string
    hint: string
    scope: ApiKeyScope
    createdAt: datetime
    expiresAt?: datetime
    lastUsedAt?: datetime
    revokedAt?: datetime
}

contract CreateApiKeyRequest: {
    name: string(min=1, max=100)
    scope: ApiKeyScope
    # Unset means the key does not expire.
    expiresInDays?: number(min=1, max=3650)
}

# A newly created or rotated key and its token. The only time the token is ever returned.
contract IssuedApiKey: {
    key: ApiKeySummary
    token: string
}

operation /api/auth/keys: {
    get: {
        name: List API keys
        sdk: listApiKeys
        service: ApiKeysService.list
        response: {
            200: {
                application/json: array(ApiKeySummary)
            }
            401:
        }
    }
    post: {
        name: Create an API key
        sdk: createApiKey
        service: ApiKeysService.create
        request: {
            application/json: CreateApiKeyRequest
        }
        response: {
            201: {
                application/json: IssuedApiKey
            }
            400:
            401:
            # Called with an API key. Sign in to create one.
            403:
        }
    }
}

operation /api/auth/keys/{id}/rotate: {
    params: {
        id: string
    }
    post: {
        name: Rotate an API key
        sdk: rotateApiKey
        service: ApiKeysService.rotate
        response: {
            200: {
                application/json: IssuedApiKey
            }
            401:
            403:
            404:
        }
    }
}

operation /api/auth/keys/{id}: {
    params: {
        id: string
    }
    delete: {
        name: Revoke an API key
        sdk: revokeApiKey
        service: ApiKeysService.revoke
        response: {
            200: {
                application/json: ApiKeySummary
            }
            401:
            404:
        }
    }
}
