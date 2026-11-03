options {
    services: {
        StageConfigService: "#modules/stages/stage.config.service.js"
    }
    security: {
        policy: wilson.manage
    }
}

# The lanes: the operator's surface, beside `board.ck`'s `GET /api/stages`, which exposes only the
# column names a board client needs. They are rows (`StageConfigStore`, apps/api/src/modules/stages),
# so this is how they are read and written: `wilson stages show|set|instructions|history|route` all
# call here.
#
# Gated (PROJECT.md decision 10): the file's floor is `wilson.manage`, which a signed-in session
# or a `manage` API key satisfies, and every `get` lowers it to `wilson.view`, which any session
# or key does. Anything without a credential gets 401 before a handler runs.
#
# Worth saying plainly for this file in particular: lane config is exactly the thing PROJECT.md
# decision 8 keeps human-write-only, because an agent that can rewrite its own exit condition passes
# every time. Saving needs `wilson.step.up`: a session that proved a factor in the last five minutes,
# which no API key ever is, so `wilson stages set` signs in fresh for the save.

# Which engine, provider and model a stage runs on, as it would dispatch now. `mode` is here so a
# client can tell the stages that reach a model from the manual ones that never do, which have no
# `model`.
contract StageRouting: {
    stage: string
    mode: enum(agent, command, manual)
    adapter: enum(api, cli, codex)
    provider: enum(anthropic, openai, xai)
    model?: string
}

contract SetStageRoutingRequest: {
    adapter: enum(api, cli, codex)
    provider: enum(anthropic, openai, xai)
    model: string
    message?: string
}

# One lane, as `wilson.lanes` holds it. `settings` is everything else a stage can say (budgets,
# commands, placement), holding only what someone chose, so a default stays a default.
contract Lane: {
    name: string
    position: int
    mode: enum(agent, command, manual)
    worktree: enum(none, readonly, rw)
    onPass: string
    onFail: string
    adapter?: enum(api, cli, codex)
    provider?: enum(anthropic, openai, xai)
    model?: string
    instructions: string
    settings: json
}

# Only what changes. A key in `settings` is set, or removed when its value is null. Routing has its own
# operation below, which checks it against what the lane's engine can run.
contract PatchLaneRequest: {
    mode?: enum(agent, command, manual)
    worktree?: enum(none, readonly, rw)
    onPass?: string
    onFail?: string
    instructions?: string
    settings?: json
    message?: string
}

# One change to a lane or, with no `lane`, to what a project's lanes share. No `snapshot` means the
# lane was removed.
contract LaneRevision: {
    id: string
    lane?: string
    snapshot?: json
    message: string
    createdAt: datetime
}

contract LaneRevisionsQuery: {
    lane?: string
    limit?: int
}

operation /api/stages/lanes: {
    get: {
        security: {
            policy: wilson.view
        }
        name: List lanes
        service: StageConfigService.lanes
        response: {
            200: {
                application/json: array(Lane)
            }
            404:
        }
    }
}

operation /api/stages/lanes/{name}: {
    params: {
        name: string
    }
    patch: {
        name: Update lane
        mcp: exclude # Human-write-only machinery (PROJECT.md decision 8): set with `wilson stages set`
        service: StageConfigService.patchLane
        security: {
            policy: wilson.step.up
        }
        request: {
            application/json: PatchLaneRequest
        }
        response: {
            200: {
                application/json: Lane
            }
            # The lane would not validate, or a route goes nowhere. The reason is in `details`.
            400:
            # No lane by that name.
            404:
        }
    }
}

operation /api/stages/lane-revisions: {
    get: {
        security: {
            policy: wilson.view
        }
        name: List lane revisions
        service: StageConfigService.laneRevisions
        query: LaneRevisionsQuery
        response: {
            200: {
                application/json: array(LaneRevision)
            }
        }
    }
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

# One lane at a time. Behind step-up for the same reason lane edits are, and
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
            # No lane by that name.
            404:
        }
    }
}
