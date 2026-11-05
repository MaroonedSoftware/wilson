options {
    services: {
        GoalService: "#modules/goal/goal.service.js"
    }
    security: {
        policy: wilson.manage
    }
}

# A piece of work a chat thread sees through (PROJECT.md, Orchestration): one thread, one project, and
# the cards that deliver it. The chat reads these and proposes changes to them through the operation
# catalog, so a person confirms creating a goal or changing what it holds, as with any other change.
#
# Gated (PROJECT.md decision 10): the file's floor is `wilson.manage`, which a signed-in session or a
# `manage` API key satisfies, and every `get` lowers it to `wilson.view`, which any session or key does.
# Anything without a credential gets 401 before a handler runs.

contract Goal: {
    id: string
    threadId: string
    project: string
    title: string
    # What done looks like, in the person's terms.
    outcome: string
    status: enum(active, paused, done, abandoned)
    createdAt: datetime
    updatedAt: datetime
}

# A card as a goal shows it.
contract GoalCard: {
    id: string
    title: string
    stage: string
    needsHuman: boolean
}

contract GoalDetail: {
    goal: Goal
    cards: array(GoalCard)
}

contract ListGoalsQuery: {
    project?: string
    status?: enum(active, paused, done, abandoned)
    threadId?: string
}

contract CreateGoalRequest: {
    # The thread that sees it through, which has no goal yet.
    threadId: string
    project: string
    title: string
    outcome: string
}

contract UpdateGoalRequest: {
    title?: string
    outcome?: string
    status?: enum(active, paused, done, abandoned)
}

operation /api/goals: {
    # The goals a project or thread has, most recently changed first. Filter by project, status or threadId.
    get: {
        security: {
            policy: wilson.view
        }
        name: List goals
        service: GoalService.list
        query: ListGoalsQuery
        response: {
            200: {
                application/json: array(Goal)
            }
        }
    }
    # Start a goal on a chat thread with no goal yet, for one registered project. `outcome` says what done looks like.
    post: {
        name: Create a goal
        service: GoalService.create
        request: {
            application/json: CreateGoalRequest
        }
        response: {
            201: {
                application/json: Goal
            }
            400:
            404:
            409:
        }
    }
}

operation /api/goals/{id}: {
    params: {
        id: string
    }
    # A goal with its cards, each card's stage, and whether it is flagged for a person.
    get: {
        security: {
            policy: wilson.view
        }
        name: Get a goal
        service: GoalService.get
        response: {
            200: {
                application/json: GoalDetail
            }
            404:
        }
    }
    # Change a goal's title, outcome or status. Anything left out stays as it is.
    patch: {
        name: Update a goal
        service: GoalService.update
        request: {
            application/json: UpdateGoalRequest
        }
        response: {
            200: {
                application/json: Goal
            }
            400:
            404:
        }
    }
}

operation /api/goals/{id}/cards/{cardId}: {
    params: {
        id: string
        cardId: string
    }
    # Linking a card the goal already holds changes nothing. A card is in at most one goal, so one that
    # another goal holds is refused rather than moved.
    # Put a card from the goal's own project in the goal. Refused when another goal holds it.
    put: {
        name: Add a card to a goal
        service: GoalService.addCard
        response: {
            200: {
                application/json: GoalDetail
            }
            404:
            409:
        }
    }
    # Take a card out of the goal. The card itself is untouched.
    delete: {
        name: Remove a card from a goal
        service: GoalService.removeCard
        response: {
            200: {
                application/json: GoalDetail
            }
            404:
        }
    }
}
