options {
    services: {
        BoardService: "#modules/board/board.service.js"
        StagesService: "#modules/stages/stages.service.js"
    }
    security: none
}

# The board's columns. They live in `config/stages.yaml` on the board repo, which a browser cannot
# read — and a board that hard-codes its columns lies the first time a stage is added, which is
# cheap to do precisely because stages are config.
contract BoardColumns: {
    stages: array(string)      # configured stages, in the order they run
    nonStages: array(string)   # parking-lot and the terminal states
}

# No `position`. `runner.cards` has the column, for ordering the parking lot, but nothing populates
# it and `Card` does not carry it — so exposing it here would have shipped a field that is absent
# from every response. It comes back when parking-lot ordering is actually built, with a value.
contract CardSummary: {
    id: string
    title: string
    stage: string
    branch?: string
    dependsOn: array(string)
}

contract CardDetail: CardSummary & {
    body: string
    sections: record(string, string)
}

contract CardEvent: {
    id: string
    type: string
    stage: string | null
    payload: json
    createdAt: datetime
}

contract CardVersion: {
    id: string
    message: string
    createdAt: datetime
}

# Shared by both history endpoints — a named contract so the generator takes the schema path
# that honours `?`, rather than the inline `query: { limit?: int }` path that renders it required.
contract ListQuery: {
    limit?: int
}

operation /api/cards: {
    get: {
        name: List cards
        service: BoardService.list
        response: {
            200: {
                application/json: array(CardSummary)
            }
        }
    }
}

operation /api/cards/{id}: {
    params: {
        id: string
    }
    get: {
        name: Get card
        service: BoardService.getById
        response: {
            200: {
                application/json: CardDetail
            }
            404:
        }
    }
}

operation /api/cards/{id}/events: {
    params: {
        id: string
    }
    get: {
        name: List card events
        service: BoardService.events
        query: ListQuery
        response: {
            200: {
                application/json: array(CardEvent)
            }
        }
    }
}

operation /api/cards/{id}/versions: {
    params: {
        id: string
    }
    get: {
        name: List card versions
        service: BoardService.versions
        query: ListQuery
        response: {
            200: {
                application/json: array(CardVersion)
            }
        }
    }
}

operation /api/stages: {
    get: {
        name: List board columns
        service: StagesService.columns
        response: {
            200: {
                application/json: BoardColumns
            }
        }
    }
}
