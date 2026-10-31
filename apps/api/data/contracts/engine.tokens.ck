options {
    services: {
        EngineTokensService: "#modules/host/engine.tokens.service.js"
    }
    security: {
        policy: wilson.manage
    }
}

# Named Claude engine tokens Wilson holds, encrypted, for the engines it starts on other machines
# (`wilson.engine_tokens`). Write-only: nothing here ever returns a token or any part of one.
#
# Every operation is `mcp: exclude`: credentials are never handed to an agent, and which credentials
# exist is not an agent's business either.

# What is shown of a saved token: its name and when it was saved, never the token.
contract EngineTokenSummary: {
    name: string
    createdAt: datetime
    updatedAt: datetime
}

contract PutEngineTokenRequest: {
    # What `claude setup-token` prints.
    token: string
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
            # A bad name, or a token that is empty or more than one word.
            400:
        }
    }
    # Forget a token. This does not revoke it with Anthropic, and an engine already running keeps it.
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
