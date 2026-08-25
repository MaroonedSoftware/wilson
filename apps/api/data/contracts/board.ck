options {
    services: {
        BoardService: "#modules/board/board.service.js"
        BoardWriteService: "#modules/board/board.write.service.js"
        BoardBootstrapService: "#modules/board/board.bootstrap.service.js"
        StagesService: "#modules/stages/stages.service.js"
        PlanService: "#modules/plan/plan.service.js"
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

# Bootstrap: scaffolding and importing the board itself, not a card. Both operate on
# `BoardConfig.boardRoot` — the path is server configuration, never a request field, so an endpoint
# here is not a remote write-anywhere-on-disk primitive (card 0076).
contract ImportBoardRequest: {
    # Report what would happen without writing anything — the one affordance that makes a one-shot,
    # irreversible import safe to attempt. Absent (the default) writes.
    dryRun?: boolean
}

contract ImportReport: {
    cards: int
    dependencies: int
    # Ids whose legacy `planSha` could not map to a version in the imported history, and were
    # re-pinned to the version this import created instead.
    unpinned: array(string)
    # True for a dry run: nothing above was written, this is a preview.
    skipped: boolean
}

# Card 0077 splits `wilson card plan` into the half that must be local — the interactive `claude`
# conversation itself, which needs the operator's own terminal — and the half that does not: cutting
# the throwaway worktree, loading the `planning` stage's model and instructions, validating the
# finished draft, writing it as a new card version, and tearing the worktree down. This contract is
# the second half. The API owns the session; the CLI (unchanged until card 0074) will own spawning
# `claude` with the operator's stdio against what this returns.
contract PlanSession: {
    # Identifies this session for the `save`/`close` calls that follow. Deterministically the card's
    # own id, not an opaque token from a session table: the worktree and its branch are always cut
    # as `plan-<id>` / a branch keyed off `<id>` (never the card's real path or branch — card 0058's
    # guard), so there is exactly one live planning session per card, and opening a new one for the
    # same id is what recovers a session whose CLI died mid-conversation. Carried as its own field
    # regardless, so this response names what it is rather than leaving a caller to assume it equals
    # the path param.
    sessionId: string
    # Absolute path to the throwaway worktree the spawned agent should be pointed at.
    worktreePath: string
    # Where the finished plan must be written, and the one file writes to it are allowed against.
    # Already seeded: the card's existing body if it has sections, the six-heading skeleton
    # otherwise — same seed `wilson card plan` writes today.
    draftPath: string
    # The `planning` stage's own model, from `stages.yaml` — never a string this contract pins.
    model: string
    # The `planning` stage's own instructions, plus the one fact only this session knows: where the
    # draft lives. Meant to travel as the spawned agent's appended system prompt, with the same
    # weight as its base instructions, not as a user turn it might treat as negotiable.
    instructions: string
}

contract SaveDraftRequest: {
    # The finished draft's full body, six headings included. There is no terminal on the other end
    # of an HTTP call for a confirmation prompt — "approval is explicit and versioned" is enforced by
    # the caller showing a diff and asking before this is ever sent, not by this contract.
    body: string
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

# Runs card 0058's two guards before cutting anything: refuses a card that is not in `planning`, and
# refuses one whose real branch already has work (re-planning a card with code on it is a different,
# more dangerous operation). Cuts nothing on a refusal.
operation /api/cards/{id}/plan/open: {
    params: {
        id: string
    }
    post: {
        name: Open a planning session
        service: PlanService.open
        response: {
            200: {
                application/json: PlanSession
            }
            400:
            404:
        }
    }
}

# Validates the six `PLAN_SECTIONS` headings and a non-empty "Files in scope" server-side — the same
# refusal `wilson card plan` makes before writing today, and it must not become something a client
# can skip, since skipping it is what let a card die at `assertDispatchable` three stages later
# (card 0058). Refuses naming what is missing. Writes exactly one new card version on success; an
# unchanged body writes nothing, the same no-op `BoardWriteService.edit` already makes.
operation /api/cards/{id}/plan/save: {
    params: {
        id: string
    }
    post: {
        name: Save a plan draft
        service: PlanService.save
        request: {
            application/json: SaveDraftRequest
        }
        response: {
            200: {
                application/json: CardDetail
            }
            # An empty or missing section, or an empty "Files in scope" — named in `details`.
            400:
            404:
        }
    }
}

# Reclaims the session's worktree and deletes its throwaway branch. Idempotent — safe to call twice,
# and safe to call for a session that opened but was never saved — because that is exactly what a CLI
# dying mid-conversation leaves behind, and closing it must never itself be the operation that fails.
operation /api/cards/{id}/plan/close: {
    params: {
        id: string
    }
    post: {
        name: Close a planning session
        service: PlanService.close
        response: {
            204:
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

# Scaffolds `BoardConfig.boardRoot`: cards/, config/, context/, a stages.yaml an operator can start a
# card against immediately, and a git repo to commit it into. The API has to be running, with
# PROJECT_BOARD_ROOT already pointing at the intended path, before it can create the board there —
# that circularity is real, and the 409 below is what makes it legible instead of a connection
# refused with no explanation.
operation /api/board/init: {
    post: {
        name: Initialise board
        service: BoardBootstrapService.init
        response: {
            # The scaffolded stages, returned as proof the config just written is one `loadStages`
            # actually accepts — not merely yaml that parses (card 0060).
            201: {
                application/json: BoardColumns
            }
            # A `stages.yaml` already exists at boardRoot. init scaffolds; it does not reset, so
            # this writes nothing.
            409:
        }
    }
}

# One-time import of the legacy markdown board (cards/*.md) into Postgres. Refuses a board that
# already has cards, the same guard `BoardImporter` always made, over HTTP now rather than only
# from the CLI.
operation /api/board/import: {
    post: {
        name: Import legacy board
        service: BoardBootstrapService.import
        request: {
            application/json: ImportBoardRequest
        }
        response: {
            200: {
                application/json: ImportReport
            }
            # No cards under boardRoot/cards, dangling dependencies in the legacy board, or a board
            # that already has cards — carried via `details` as the card mutations above do.
            400:
        }
    }
}
