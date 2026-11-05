options {
    services: {
        AppApiService: "#modules/apps/app.api.service.js"
    }
    security: {
        policy: wilson.view
    }
}

# What operator apps read, and the promise made to whoever writes one (PROJECT.md, Operator apps). The
# hosts answer `window.wilson` from these routes alone, so the board can change its own contracts without
# changing what an installed app receives, and a field is exposed to apps only by being listed here.
#
# A version is kept for as long as any host offers it. Adding a field or a route to it is fine. Changing
# or removing one means a new set of routes and contracts under the next number, with this set left alone.
#
# Grants are not checked here. An app holds no credential, so these are ordinary reads by the signed-in
# person, and the host decides what an app may ask for (decision 12). Reading the same data from the board's
# own routes takes the same policy. Every operation is out of an agent's reach (decision 8).

contract AppV1DoneReason: enum(merged, poisoned, dropped, split)

# What pressing Merge on a `ready` card would do right now.
contract AppV1MergeStatus: {
    state: enum(clean, conflict, rereview, capped, unknown)
    target?: string
    conflicts: array(string)
    movedUnder: array(string)
    reason?: string
}

# The question a stage stopped to ask.
contract AppV1CardBlocked: {
    category: enum(decision, access, requirements, environment, other)
    tried: string
    question: string
    options?: array(string)
    stage: string
    askedAt: datetime
}

contract AppV1Card: {
    id: string
    title: string
    stage: string
    doneReason?: AppV1DoneReason
    planCheck?: enum(checking, refused)
    planCheckReason?: string
    # The branch the card's work is on, whether recorded or derived from its title.
    branch?: string
    dependsOn: array(string)
    needsHuman: boolean
    needsHumanReason?: string
    blocked?: AppV1CardBlocked
    position?: int
    splitFrom?: string
    stageEnteredAt?: datetime
    mergeStatus?: AppV1MergeStatus
}

contract AppV1SplitPiece: {
    id: string
    title: string
    stage: string
    doneReason?: AppV1DoneReason
}

contract AppV1CardDetail: AppV1Card & {
    body: string
    sections: record(string, string)
    pieces?: array(AppV1SplitPiece)
}

contract AppV1BoardColumns: {
    stages: array(string)
    nonStages: array(string)
}

# One thing that happened on the project, without the event's own payload, whose shape belongs to the event
# log. `cardTitle` is null when the card no longer exists.
contract AppV1ActivityEvent: {
    id: string
    cardId: string
    cardTitle: string | null
    type: string
    stage: string | null
    createdAt: datetime
}

contract AppV1ActivityQuery: {
    limit?: int
    before?: int
}

contract AppV1StatsQuery: {
    days?: int
}

contract AppV1StatsCounts: {
    attempts: int
    passed: int
    failed: int
    interrupted: int
    inputTokens: int
    cachedInputTokens: int
    outputTokens: int
}

contract AppV1StageStats: AppV1StatsCounts & {
    stage: string
    cards: int
}

contract AppV1DayStats: AppV1StatsCounts & {
    date: string
}

contract AppV1CardStats: AppV1StatsCounts & {
    cardId: string
    cardTitle?: string
}

contract AppV1StatsTotal: AppV1StatsCounts & {
    cards: int
}

contract AppV1ConversationStats: {
    kind: enum(planning, review)
    turns: int
    cards: int
    inputTokens: int
    cachedInputTokens: int
    outputTokens: int
}

contract AppV1Stats: {
    since: datetime
    until: datetime
    zone: string
    total: AppV1StatsTotal
    stages: array(AppV1StageStats)
    days: array(AppV1DayStats)
    topCards: array(AppV1CardStats)
    conversations: array(AppV1ConversationStats)
}

operation /api/app-api/v1/cards: {
    get: {
        name: List cards for an app
        mcp: exclude # Apps are the operator's, like the rest of the machinery
        sdk: listCardsV1
        service: AppApiService.listCards
        response: {
            200: {
                application/json: array(AppV1Card)
            }
            401:
        }
    }
}

operation /api/app-api/v1/cards/{id}: {
    params: {
        id: string
    }
    get: {
        name: Get a card for an app
        mcp: exclude # Apps are the operator's, like the rest of the machinery
        sdk: getCardV1
        service: AppApiService.getCard
        response: {
            200: {
                application/json: AppV1CardDetail
            }
            401:
            404:
        }
    }
}

operation /api/app-api/v1/columns: {
    get: {
        name: List board columns for an app
        mcp: exclude # Apps are the operator's, like the rest of the machinery
        sdk: listBoardColumnsV1
        service: AppApiService.listBoardColumns
        response: {
            200: {
                application/json: AppV1BoardColumns
            }
            401:
        }
    }
}

operation /api/app-api/v1/activity: {
    get: {
        name: List project activity for an app
        mcp: exclude # Apps are the operator's, like the rest of the machinery
        sdk: listProjectActivityV1
        service: AppApiService.listProjectActivity
        query: AppV1ActivityQuery
        response: {
            200: {
                application/json: array(AppV1ActivityEvent)
            }
            401:
        }
    }
}

operation /api/app-api/v1/stats: {
    get: {
        name: Get project stats for an app
        mcp: exclude # Apps are the operator's, like the rest of the machinery
        sdk: getProjectStatsV1
        service: AppApiService.getProjectStats
        query: AppV1StatsQuery
        response: {
            200: {
                application/json: AppV1Stats
            }
            401:
        }
    }
}
