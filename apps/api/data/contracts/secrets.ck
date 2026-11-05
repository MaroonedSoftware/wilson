options {
    services: {
        SecretsService: "#modules/secrets/secrets.service.js"
    }
    security: {
        policy: wilson.step.up
    }
}

# Named values Wilson holds, encrypted, to use on the operator's behalf (`wilson.secrets`). Write-only:
# nothing here ever returns a value or any part of one.
#
# The floor is `wilson.step.up`, because a saved secret is authority an API key should not be able to
# replace. Every operation is `mcp: exclude`: secrets are never handed to an agent, and which secrets
# exist is not an agent's business either (PROJECT.md decision 8).

# What is shown of a saved secret: its name and when it was saved, never its value.
contract SecretSummary: {
    name: string
    createdAt: datetime
    updatedAt: datetime
}

contract PutSecretRequest: {
    value: string
}

operation /api/secrets: {
    get: {
        mcp: exclude # Which secrets exist is not an agent's business
        security: {
            policy: wilson.view
        }
        name: List secrets
        service: SecretsService.list
        response: {
            200: {
                application/json: array(SecretSummary)
            }
        }
    }
}

operation /api/secrets/{name}: {
    params: {
        name: string
    }
    # Save a value under `name`, replacing any saved there, so rotating is putting again.
    put: {
        mcp: exclude # Secrets are never handed to an agent
        name: Put secret
        service: SecretsService.put
        request: {
            application/json: PutSecretRequest
        }
        response: {
            200: {
                application/json: SecretSummary
            }
            # A bad name, or an empty value.
            400:
        }
    }
    # Forget a secret. This does not revoke it with whoever issued it.
    delete: {
        mcp: exclude # Secrets are never handed to an agent
        name: Remove secret
        service: SecretsService.remove
        response: {
            204:
            404:
        }
    }
}
