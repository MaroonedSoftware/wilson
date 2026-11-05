options {
    services: {
        EvalFixturesService: "#modules/evals/eval.fixtures.service.js"
    }
    security: {
        policy: wilson.manage
    }
}

# Replaying past stage attempts to measure a lane change (PROJECT.md, Evals). The operator's surface:
# `wilson eval ...` calls here. Nothing here is in the operation catalog, because an eval spends tokens
# and runs a config nobody has saved, and PROJECT.md decision 8 keeps that machinery human-only.
#
# Gated (PROJECT.md decision 10): the file's floor is `wilson.manage`, and every `get` lowers it to
# `wilson.view`.

# One past attempt, kept to be run again. `warnings` is only ever filled when capturing one.
contract EvalFixture: {
    id: string
    sourceCardId: string
    title: string
    stage: string
    planVersionId: string
    baseSha: string
    headSha: string
    warnings: array(string)
    createdAt: datetime
}

# `attempt` counts from 1, oldest first, and defaults to the card's latest attempt at that stage.
contract CaptureEvalFixtureRequest: {
    cardId: string
    stage: string
    attempt?: int
}

operation /api/evals/fixtures: {
    get: {
        security: {
            policy: wilson.view
        }
        name: List eval fixtures
        mcp: exclude
        service: EvalFixturesService.list
        response: {
            200: {
                application/json: array(EvalFixture)
            }
        }
    }
    post: {
        name: Capture eval fixture
        mcp: exclude
        service: EvalFixturesService.capture
        request: {
            application/json: CaptureEvalFixtureRequest
        }
        response: {
            201: {
                application/json: EvalFixture
            }
            400:
            404:
            409:
        }
    }
}

operation /api/evals/fixtures/{id}: {
    params: {
        id: string
    }
    delete: {
        name: Remove eval fixture
        mcp: exclude
        service: EvalFixturesService.remove
        response: {
            204:
            404:
        }
    }
}
