options {
    services: {
        BoardService: "#modules/board/board.service.js"
        BoardWriteService: "#modules/board/board.write.service.js"
        StagesService: "#modules/stages/stages.service.js"
    }
    security: none
}

# `security: none` is deliberate here too, not an oversight carried over from the read surface: the
# API binds to 127.0.0.1 (BoardConfig/server startup), so anything that can reach these operations
# can already run `wilson card ...` on this machine directly. There is no auth boundary to enforce
# yet. The day this listens on anything but localhost, every operation below — read and write alike
# — needs a real answer to "who is allowed to do this", and this comment is the marker to come back
# and add it.

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
    # Required, unlike the frontmatter's optional `needsHuman?`, so the web never has to write
    # `?? false` — every card has an answer to "does this need a human", even if that answer is no.
    needsHuman: boolean
    needsHumanReason?: string
}

contract CardDetail: CardSummary & {
    body: string
    sections: record(string, string)
}

# The write surface. Each request body is its own named contract rather than inlined on the
# operation, for the same reason `ListQuery` is one: contractkit only honours a field's `?` down
# the schema path a named type takes, and every one of card 0080's five mutations copies this shape.
#
# `id` never appears in a request body — it is either a path param (move, edit act on a card that
# already exists) or, for create, assigned by the service the same way `wilson card create` assigns
# it: the next sequential id over the current board. A client cannot pick one.
contract CreateCardRequest: {
    title: string
    # Defaults to parking-lot — same default `wilson card create --stage` uses.
    stage?: string
    # The full plan body. The CLI seeds `$EDITOR` with a skeleton and a human fills it in there;
    # there is no terminal on the other end of an HTTP call, so the caller sends the finished text
    # directly rather than a seed to edit interactively.
    body: string
}

contract MoveCardRequest: {
    # The target stage. Validated against the board's own stage graph (`validTargets`), exactly as
    # `wilson card move` validates it — not against a fixed enum here, because the graph is config
    # and can grow a stage without a contract change.
    stage: string
}

contract EditCardRequest: {
    body: string
}

contract DependCardRequest: {
    dependsOnId: string
    # Absent (the default) records the dependency; `true` drops it instead — mirroring `wilson card
    # depend`'s `--remove` flag.
    remove?: boolean
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
    post: {
        name: Create card
        service: BoardWriteService.create
        request: {
            application/json: CreateCardRequest
        }
        response: {
            201: {
                application/json: CardDetail
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
    # Not `put`. This is a partial update — only the body changes, frontmatter is not editable here
    # (decision 5: stage, branch, retries are runner state; `move` is the recorded way to override
    # stage) — which is exactly what `patch` means and `put`, a full replace, does not.
    patch: {
        name: Edit card body
        service: BoardWriteService.edit
        request: {
            application/json: EditCardRequest
        }
        response: {
            200: {
                application/json: CardDetail
            }
            404:
        }
    }
}

# A sub-resource action rather than `PATCH /api/cards/{id}` with a `stage` field: a move is a
# recorded transition with its own event (`writeWithEvent`), not an edit to a stored field, and card
# 0080's other five mutations — depend, ack, approve, start, release — are transitions of exactly
# this shape. `POST .../move` establishes that convention once so five more operations can copy it
# rather than each inventing its own.
operation /api/cards/{id}/move: {
    params: {
        id: string
    }
    post: {
        name: Move card
        service: BoardWriteService.move
        request: {
            application/json: MoveCardRequest
        }
        response: {
            200: {
                application/json: CardDetail
            }
            # Same refusal `wilson card move` makes for a target the stage graph does not define,
            # carried as the same message via `details` (see BoardWriteService.move).
            400:
            404:
        }
    }
}


# Card 0080's other four mutations are pure transitions or a flag action; `depend` alone edits one
# field (`dependsOn`) the way `PATCH .../id` edits `body` — it is still a POST action rather than a
# PATCH because the edit is additive/subtractive (`remove`), not a full replace of the field the way
# `EditCardRequest` replaces `body`.
operation /api/cards/{id}/depend: {
    params: {
        id: string
    }
    post: {
        name: Set card dependency
        service: BoardWriteService.depend
        request: {
            application/json: DependCardRequest
        }
        response: {
            200: {
                application/json: CardDetail
            }
            # Same refusal `wilson card depend` makes for a card depending on itself, carried via
            # `details` as the move operation's 400 is. The same 404 covers either id — the card or
            # the one it would depend on — not existing.
            400:
            404:
        }
    }
}

operation /api/cards/{id}/ack: {
    params: {
        id: string
    }
    post: {
        name: Acknowledge a flagged card
        service: BoardWriteService.ack
        response: {
            200: {
                application/json: CardDetail
            }
            # `wilson card ack` exits 1 for a card that is not flagged; the same refusal is this 400
            # here rather than a silent no-op.
            400:
            404:
        }
    }
}

operation /api/cards/{id}/approve: {
    params: {
        id: string
    }
    post: {
        name: Approve card plan
        service: BoardWriteService.approve
        response: {
            200: {
                application/json: CardDetail
            }
            # `wilson card approve`'s two refusals — outside `backlog`, or an empty "Files in scope" —
            # both carried as this 400.
            400:
            404:
        }
    }
}

operation /api/cards/{id}/start: {
    params: {
        id: string
    }
    post: {
        name: Start card
        service: BoardWriteService.start
        response: {
            200: {
                application/json: CardDetail
            }
            # Whatever `whyNotDispatchable` refuses, or a card a job is already carrying — the same
            # two refusals `wilson card start` makes before enqueuing.
            400:
            404:
        }
    }
}

operation /api/cards/{id}/release: {
    params: {
        id: string
    }
    post: {
        name: Release card
        service: BoardWriteService.release
        response: {
            200: {
                application/json: CardDetail
            }
            # No claim to release, or a daemon that might genuinely have the job in flight — the same
            # two refusals `wilson card release` makes before cancelling.
            400:
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
