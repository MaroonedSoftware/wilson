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
    createdAt: datetime
    updatedAt: datetime
    # The worker hosts assigned this token, name ascending.
    hosts: array(string)
}

contract PutEngineTokenRequest: {
    # What `claude setup-token` prints.
    token: string
    # Each of these keeps what is saved under this name when left out, or its default on a new name:
    # anthropic, subscription and 0.
    provider?: EngineTokenProvider
    kind?: EngineTokenKind
    # 0 to 1000.
    priority?: int
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
