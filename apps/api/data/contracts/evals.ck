options {
    services: {
        EvalFixturesService: "#modules/evals/eval.fixtures.service.js"
        EvalBatchesService: "#modules/evals/eval.batches.service.js"
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

# One batch: fixtures run again on one host, up to a limit on what it spends. `waitingReason` says why
# nothing is running right now, such as a host with no slot free.
contract EvalBatch: {
    id: string
    status: enum(running, finished, stopped)
    host: string
    runsPerFixture: int
    maxOutputTokens: int
    spentOutputTokens: int
    stopReason?: string
    waitingReason?: string
    createdAt: datetime
    finishedAt?: datetime
}

# One run of one fixture. `interrupted` and `abandoned` say nothing about the config, and are counted
# apart from `passed` and `failed`.
contract EvalRun: {
    id: string
    fixtureId: string
    arm: enum(current, candidate)
    status: enum(queued, running, passed, failed, errored, interrupted, abandoned, skipped)
    failures: array(string)
    unjudged: boolean
    reportRejected: boolean
    truncated: boolean
    hasPatch: boolean
    error?: string
    wallClockMs?: int
    inputTokens?: int
    cachedInputTokens?: int
    outputTokens?: int
    toolCalls?: int
    scopeDenials?: int
}

contract EvalSpread: {
    median: int
    min: int
    max: int
}

contract EvalFailureCount: {
    reason: string
    count: int
}

# One arm on one fixture. There is no verdict here on purpose: with a handful of runs, the honest
# report is the counts and the spread.
contract EvalArmSummary: {
    fixtureId: string
    arm: enum(current, candidate)
    passed: int
    failed: int
    errored: int
    interrupted: int
    pending: int
    outputTokens?: EvalSpread
    wallClockMs?: EvalSpread
    failures: array(EvalFailureCount)
}

contract EvalBatchDetail: {
    batch: EvalBatch
    runs: array(EvalRun)
    summary: array(EvalArmSummary)
}

contract EvalRunPatch: {
    patch: string
    truncated: boolean
}

# `runs` is per fixture and defaults to 3. `maxOutputTokens` defaults to 300000.
contract CreateEvalBatchRequest: {
    fixtureIds: array(string)
    host: string
    runs?: int
    maxOutputTokens?: int
}

contract ListEvalBatchesQuery: {
    limit?: int
}

# Starting a batch needs `wilson.step.up`, as saving a lane does: it spends tokens and runs a config
# nobody has saved, so a leaked `manage` key must not be able to.
operation /api/evals/batches: {
    get: {
        security: {
            policy: wilson.view
        }
        name: List eval batches
        mcp: exclude
        service: EvalBatchesService.list
        query: ListEvalBatchesQuery
        response: {
            200: {
                application/json: array(EvalBatch)
            }
        }
    }
    post: {
        name: Create eval batch
        mcp: exclude
        service: EvalBatchesService.create
        security: {
            policy: wilson.step.up
        }
        request: {
            application/json: CreateEvalBatchRequest
        }
        response: {
            201: {
                application/json: EvalBatchDetail
            }
            400:
            404:
        }
    }
}

operation /api/evals/batches/{id}: {
    params: {
        id: string
    }
    get: {
        security: {
            policy: wilson.view
        }
        name: Get eval batch
        mcp: exclude
        service: EvalBatchesService.show
        response: {
            200: {
                application/json: EvalBatchDetail
            }
            404:
        }
    }
}

# What has not started is skipped. A run in progress finishes and is kept.
operation /api/evals/batches/{id}/stop: {
    params: {
        id: string
    }
    post: {
        name: Stop eval batch
        mcp: exclude
        service: EvalBatchesService.stop
        response: {
            200: {
                application/json: EvalBatchDetail
            }
            404:
        }
    }
}

# What a run left in its tree, cut at 256 KB. Empty for a run that changed nothing.
operation /api/evals/runs/{id}/patch: {
    params: {
        id: string
    }
    get: {
        security: {
            policy: wilson.view
        }
        name: Get eval run patch
        mcp: exclude
        service: EvalBatchesService.patch
        response: {
            200: {
                application/json: EvalRunPatch
            }
            404:
        }
    }
}
