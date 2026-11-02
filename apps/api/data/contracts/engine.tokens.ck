options {
    services: {
        EngineTokensService: "#modules/host/engine.tokens.service.js"
    }
    security: {
        policy: wilson.manage
    }
}

# Named engine tokens Wilson holds, encrypted, for the engines it starts on other machines
# (`wilson.engine_tokens`). Write-only: nothing here ever returns a token or any part of one.
#
# Every operation is `mcp: exclude`: credentials are never handed to an agent, and which credentials
# exist is not an agent's business either.

# Who a token signs in to.
contract EngineTokenProvider: enum(anthropic, openai, xai)

# How it signs in: a plan's own login, or a key billed per token.
contract EngineTokenKind: enum(subscription, api_key)

# What is shown of a saved token: its name, what it signs in to and when it was saved, never the token.
contract EngineTokenSummary: {
    name: string
    provider: EngineTokenProvider
    kind: EngineTokenKind
    # Which of a provider's tokens comes first, lowest first.
    priority: int
    # Whether Wilson may choose this token for an engine with no token assigned.
    pooled: boolean
    createdAt: datetime
    updatedAt: datetime
    # The worker hosts assigned this token, name ascending.
    hosts: array(string)
}

contract PutEngineTokenRequest: {
    # What `claude setup-token` prints.
    token: string
    # Each of these keeps what is saved under this name when left out, or its default on a new name:
    # anthropic, subscription, 0 and not pooled.
    provider?: EngineTokenProvider
    kind?: EngineTokenKind
    # 0 to 1000.
    priority?: int
    pooled?: boolean
}

# What can change about a saved token without saving it again. What is left out stays as it is.
contract UpdateEngineTokenRequest: {
    provider?: EngineTokenProvider
    kind?: EngineTokenKind
    # 0 to 1000.
    priority?: int
    pooled?: boolean
}

# A usage limit an account has hit that has not reset. `account` is a saved token's name, `local` for
# the sign-in of engines on this machine, or `worker:<host>` for a worker's own.
contract EngineLimit: {
    account: string
    limitType: string
    resetsAt: datetime
}

operation /api/engine-limits: {
    get: {
        mcp: exclude # Which credentials exist is not an agent's business
        security: {
            policy: wilson.view
        }
        name: List engine limits
        service: EngineTokensService.limitsInForce
        response: {
            200: {
                application/json: array(EngineLimit)
            }
        }
    }
}

operation /api/engine-tokens: {
    get: {
        mcp: exclude # Credentials are never handed to an agent
        security: {
            policy: wilson.view
        }
        name: List engine tokens
        service: EngineTokensService.list
        response: {
            200: {
                application/json: array(EngineTokenSummary)
            }
        }
    }
}

operation /api/engine-tokens/{name}: {
    params: {
        name: string
    }
    # Save a token under `name`, replacing any saved there, so rotating is putting again. A new value
    # reaches the next engine started with it, never one already running.
    put: {
        mcp: exclude # Credentials are never handed to an agent
        name: Put engine token
        service: EngineTokensService.put
        request: {
            application/json: PutEngineTokenRequest
        }
        response: {
            200: {
                application/json: EngineTokenSummary
            }
            # A bad name or priority, a token that is empty or more than one word, or a host assigned
            # this token that could not sign in with what it would become.
            400:
        }
    }
    # Change what is recorded about a saved token, keeping the token and what it has hit.
    patch: {
        mcp: exclude # Credentials are never handed to an agent
        name: Update engine token
        service: EngineTokensService.update
        request: {
            application/json: UpdateEngineTokenRequest
        }
        response: {
            200: {
                application/json: EngineTokenSummary
            }
            # A bad priority, or a host assigned this token that could not sign in with what it would become.
            400:
            404:
        }
    }
    # Forget a token. This does not revoke it with Anthropic, and an engine already running keeps it.
    # Hosts assigned it go back to the worker's own sign-in.
    delete: {
        mcp: exclude # Credentials are never handed to an agent
        name: Remove engine token
        service: EngineTokensService.remove
        response: {
            204:
            404:
        }
    }
}
