options {
    services: {
        ApiKeysService: "#modules/authentication/api.keys.service.js"
    }
    security: {
        policy: wilson.manage
    }
}

# The operator's API keys (PROJECT.md, Authentication): what the CLI and scripts send as
# `Authorization: Bearer wl_...`. The token is shown once, when a key is created or rotated, and only
# its hash is kept.
#
# The floor is `wilson.manage`. Listing and revoking lower it to `wilson.view`, so any key can see
# the keys and revoke one, its own included, since revoking only ever takes authority away. Creating
# and rotating raise it to `wilson.step.up`: only a session that proved a factor in the last five
# minutes, never a key (403), so one leaked key cannot be turned into more.

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
        security: {
            policy: wilson.view
        }
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
        security: {
            policy: wilson.step.up
        }
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
            # Called with an API key, or a session whose factor is older than five minutes. Sign in.
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
        security: {
            policy: wilson.step.up
        }
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
        security: {
            policy: wilson.view
        }
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
