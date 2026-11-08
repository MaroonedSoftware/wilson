options {
    services: {
        EngineTokensService: "#modules/host/engine.tokens.service.js"
        EngineUsageService: "#modules/host/engine.usage.service.js"
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
    # What `claude setup-token` prints, or an API key. An OpenAI token has to be an API key.
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

# The name to hold a saved token under from now on.
contract RenameEngineTokenRequest: {
    name: string
}

# A usage limit an account has hit that has not reset. `account` is a saved token's name, `local` for
# the sign-in of engines on this machine, or `worker:<host>` for a worker's own.
contract EngineLimit: {
    account: string
    limitType: string
    resetsAt: datetime
}

# How many days `GET /api/engine-accounts/usage` reads, today included. Defaults to 30, and is held to
# between 1 and 365. A day starts at the server's midnight, as in `GET /api/stats`.
contract EngineAccountUsageQuery: {
    days?: int
}

# What one engine account spent, across every project: stage runs, chat turns and planning turns. `account`
# is named as `EngineLimit.account` is. `inputTokens` includes `cachedInputTokens`, as in `ProjectStatsCounts`.
# Spend recorded before accounts were named, by the `api` engine, by a rule judge, or in a review
# conversation, is in no row.
contract EngineAccountUsage: {
    account: string
    # Output tokens since the server's midnight.
    todayOutputTokens: int
    # The rest are over the whole window.
    outputTokens: int
    inputTokens: int
    cachedInputTokens: int
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

# A sub-resource action rather than a `name` field on `UpdateEngineTokenRequest`, which would change
# what the generated `updateEngineToken` means for every caller. The name is the key, so this is the
# only way to change it without removing the token and saving it again, which loses it: the token
# cannot be read back.
#
# What moves: the token's own row, and the assignment of every worker host that holds it — the latter
# by the foreign key's `ON UPDATE CASCADE`, not by a second write. What does not: the token itself, its
# `provider`, `kind`, `priority`, `pooled`, `createdAt` and `updatedAt` (a rename is not a re-save);
# recorded spend, which keeps the old name, so `GET /api/engine-accounts/usage` lists the old and the
# new name separately for a window that straddles a rename; and a usage limit in force, which stays
# recorded against the old name. Renaming to the current name is a no-op, not an error.
#
# A rename does not reach a running engine. An engine is started with the account name resolved then
# and handed the token's value, never its name, so a run in flight carries on untouched and the next
# engine started gets the new name. A limit a running engine reports after the rename is therefore
# recorded against the old name: it shows as a stray account in `GET /api/engine-limits` until it
# resets, and the renamed account shows no badge for it — as `put` never reaches a running engine
# either.
operation /api/engine-tokens/{name}/rename: {
    params: {
        name: string
    }
    post: {
        mcp: exclude # Credentials are never handed to an agent
        name: Rename engine token
        service: EngineTokensService.rename
        request: {
            application/json: RenameEngineTokenRequest
        }
        response: {
            200: {
                application/json: EngineTokenSummary
            }
            # The requested name is not usable: it fails the token-name shape, or another saved token
            # already holds it.
            400:
            # Nothing is saved under the current name.
            404:
        }
    }
}

# Each account that spent anything in the window, most output first.
operation /api/engine-accounts/usage: {
    get: {
        mcp: exclude # Which credentials exist is not an agent's business
        security: {
            policy: wilson.view
        }
        name: List engine account usage
        service: EngineUsageService.usage
        query: EngineAccountUsageQuery
        response: {
            200: {
                application/json: array(EngineAccountUsage)
            }
        }
    }
}
