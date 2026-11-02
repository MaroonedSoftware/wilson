options {
    services: {
        StageConfigService: "#modules/stages/stage.config.service.js"
    }
    security: {
        policy: wilson.manage
    }
}

# The stage config document itself — the operator's surface, beside `board.ck`'s `GET /api/stages`,
# which exposes only the column names a board client needs. Stage config used to be
# `config/stages.yaml` in the sibling board repo, edited in place and committed there; it is a
# `wilson.stage_configs` row now (`StageConfigStore`, apps/api/src/modules/stages), so this is how it
# is read and written: `wilson stages show|edit|set|versions` all call here.
#
# Gated (PROJECT.md decision 10): the file's floor is `wilson.manage`, which a signed-in session
# or a `manage` API key satisfies, and every `get` lowers it to `wilson.view`, which any session
# or key does. Anything without a credential gets 401 before a handler runs.
#
# Worth saying plainly for this file in particular: the stage config is exactly the thing PROJECT.md
# decision 8 keeps human-write-only, because an agent that can rewrite its own exit condition passes
# every time. Before decision 10 nothing stopped project code a stage ran from calling this endpoint;
# now saving needs `wilson.step.up`: a session that proved a factor in the last five minutes, which no
# API key ever is, so `wilson stages edit|set` sign in fresh for the save.

# One stored document. `yaml` is the text verbatim, comments included — the document is the config,
# not a rendering of columns. `message` is what the commit message on `stages.yaml` used to be.
contract StageConfigDocument: {
    id: string
    yaml: string
    message: string
    createdAt: datetime
}

# `message` optional: `wilson stages edit` has no commit-message prompt the way `git commit` does,
# and a default ("Edited stage config") beats forcing one. Supply it when the change is worth a
# sentence — "Raise the review step budget to 150" is what the history is for.
contract SetStageConfigRequest: {
    yaml: string
    message?: string
}

contract StageConfigVersion: {
    id: string
    message: string
    createdAt: datetime
}

# Same shape as board.ck's `ListQuery`, declared here rather than shared: a contract file is the
# unit contractkit generates from, and a cross-file reference is not worth a coupling for one
# optional field.
contract StageConfigVersionsQuery: {
    limit?: int
}

# Which engine, provider and model a stage runs on, as it would dispatch now. `mode` is here so a
# client can tell the stages that reach a model from the manual ones that never do.
contract StageRouting: {
    stage: string
    mode: enum(agent, command, manual)
    adapter: enum(api, cli)
    provider: enum(anthropic, openai, xai)
    model: string
}

contract SetStageRoutingRequest: {
    adapter: enum(api, cli)
    provider: enum(anthropic, openai, xai)
    model: string
    message?: string
}

operation /api/stages/routing: {
    get: {
        security: {
            policy: wilson.view
        }
        name: List stage routing
        service: StageConfigService.routing
        response: {
            200: {
                application/json: array(StageRouting)
            }
            404:
        }
    }
}

# One stage at a time, unlike the document. Behind step-up for the same reason the document is, and
# because an agent that could choose its own model could choose the most expensive one.
operation /api/stages/routing/{stage}: {
    params: {
        stage: string
    }
    put: {
        name: Set stage routing
        mcp: exclude # Human-write-only machinery (PROJECT.md decision 8): set with `wilson stages route`
        service: StageConfigService.setRouting
        security: {
            policy: wilson.step.up
        }
        request: {
            application/json: SetStageRoutingRequest
        }
        response: {
            200: {
                application/json: StageRouting
            }
            # An empty model, or a provider this stage's engine cannot run. The reason is in `details`.
            400:
            # No stage by that name in the project's stage config.
            404:
        }
    }
}

operation /api/stages/config: {
    get: {
        security: {
            policy: wilson.view
        }
        name: Get stage config
        service: StageConfigService.get
        response: {
            200: {
                application/json: StageConfigDocument
            }
            # The project has no stage config yet — `wilson board init` scaffolds one, or
            # `wilson stages set <file>` supplies one.
            404:
        }
    }
    # `put`, not `patch`: the document is replaced whole. Every save is a new row; the previous
    # document is still there in the history, so a bad edit is undone by saving the earlier text
    # again, never by deleting anything.
    put: {
        name: Set stage config
        mcp: exclude # Human-write-only machinery (PROJECT.md decision 8): edited with `wilson stages edit`
        service: StageConfigService.set
        security: {
            policy: wilson.step.up
        }
        request: {
            application/json: SetStageConfigRequest
        }
        response: {
            200: {
                application/json: StageConfigDocument
            }
            # The document does not validate — not YAML, not the schema, or a route to a state
            # that does not exist. Nothing is written; the reason is in `details`, the same way a
            # card mutation's refusal is.
            400:
        }
    }
}

operation /api/stages/config/versions: {
    get: {
        security: {
            policy: wilson.view
        }
        name: List stage config versions
        service: StageConfigService.versions
        query: StageConfigVersionsQuery
        response: {
            200: {
                application/json: array(StageConfigVersion)
            }
        }
    }
}
