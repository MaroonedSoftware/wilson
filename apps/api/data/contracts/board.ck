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

# Card 0091. Orders the parking lot; `list`'s `position, id` ordering (PostgresBoardRepository)
# sorts a card with one ahead of every card without. Absent for a card nothing has ever dragged —
# including every card that predates this, since there is no migration to back-fill it — and such a
# card sorts by `id` among the others like it, not at either end of the column. Meaningless outside
# `parking-lot`: no other stage's order is an operator's to set (POST .../reposition refuses it).
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
    position?: int
}

contract CardDetail: CardSummary & {
    body: string
    sections: record(string, string)
}

# `BoardWriteService.release`'s response (card 0087): the card, plus which of the two safe-to-cancel
# cases it took. `queued` is a job in `created` or `retry` — by definition nothing has picked it up,
# so cancelling it cannot interrupt anything. `orphan` is a job the broker still shows `active` but
# that this process's own tracking confirms nothing is currently running — left behind by an earlier
# process that crashed before it could clear or hand off. A job genuinely mid-run stays refused (see
# the release operation's 400 below) and never reaches this response at all.
contract ReleaseResult: CardDetail & {
    releasedAs: enum(queued, orphan)
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

# Card 0091. The two cards `id` should land between in the parking lot, by id rather than by a
# position value: a value would leak the sparse-integer scheme (`card.position.ts`) onto the wire,
# where a client would have no way to compute one that is still valid by the time this request
# lands. Either may be absent — both absent together means "the only card in the column" — since a
# drop can land at either end, where there is nothing on that side to name.
contract RepositionCardRequest: {
    # The card `id` should sit immediately after, or absent for the top of the column.
    beforeId?: string
    # The card `id` should sit immediately before, or absent for the bottom of the column.
    afterId?: string
}

contract EditCardRequest: {
    body: string
}

# Card 0094. Its own request shape rather than a `title` field on `EditCardRequest`: adding one there
# would rename the generated SDK method `editCardBody` (and its caller and the test that names it)
# for no behavioural gain, where `POST .../rename` is purely additive.
contract RenameCardRequest: {
    title: string
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

# Card 0133: the daemon can hold a planning conversation for a card itself. `POST .../plan/turn`'s
# request — one message in that conversation.
contract PlanTurnRequest: {
    text: string
}

# One row of `runner.plan_turns` — a turn in a card's planning conversation, whether this is
# `POST .../plan/turn`'s response (the just-appended assistant turn) or one of the entries
# `GET .../plan/stream` replays after a client's `Last-Event-ID`.
contract PlanTurn: {
    # `Last-Event-ID`'s resume key: monotonic per card, so a reconnecting client asks for every turn
    # with `seq` greater than the last one it saw.
    seq: int
    role: enum(user, assistant)
    content: string
    createdAt: datetime
}

# Card 0140. `open` writes `draft.md` and hands back its server-local path (`PlanSession.draftPath`)
# — no use to a browser, which is never on the same filesystem the CLI is (card 0077's split). This
# is the content a client reads instead: exactly what is on disk, whether that is the seed `open`
# wrote, a draft the agent is partway through, or the last thing `save` wrote before the session
# closed. See `PlanService.draft` for what an id with no draft yet gets instead of this.
contract PlanDraft: {
    body: string
}

# Card 0113. One piece of a scope-check refusal's division (see `ScopeDivisionPieceSchema`,
# apps/api/src/modules/stages/stage.result.ts) — carried over the wire twice: as reported, from
# `GET .../division`, and again, possibly with `dependsOn` edited, in the body of `POST .../split`.
# One shape for both directions so a client can round-trip a piece it only meant to touch one field
# of.
contract DivisionPiece: {
    title: string
    tasks: array(string)
    delivers: string
    # Titles of other pieces in the same division this piece's own report named as blocking it.
    # `ScopeDivisionPieceSchema` defaults this to `[]` whether the model said "independent" or simply
    # did not say — an empty array here is not proof of independence. A client must show this field
    # as reported and let an operator add to it before anything is created; it must not try to infer
    # a missing dependency from `delivers` prose.
    dependsOn: array(string)
}

# `GET /api/cards/{id}/division`'s response: the most recent scope-check refusal on record for a
# card. Read from the event log, not a fresh run — `scope-check` already happened, and re-running it
# could return a different division for the cost of a whole pass, which is `scope-check`'s job to
# spend, not this endpoint's.
contract CardDivision: {
    # The refusal's own stated reason (`ScopeCheckResultSchema.reason`) — repetition, named in the
    # model's own words, not merely "refused".
    reason: string
    pieces: array(DivisionPiece)
}

# `POST /api/cards/{id}/split`'s request: every piece to create, exactly as an operator confirmed
# it — `title`/`tasks`/`delivers` as `scope-check` reported them, `dependsOn` as the operator left it
# after being shown what was reported and given the chance to add to it. The endpoint does not go
# back to the event log to re-read the division itself; the confirmed pieces are the only truth it
# acts on.
contract SplitCardsRequest: {
    pieces: array(DivisionPiece)
}

# `POST /api/cards/{id}/split`'s response: the origin card, re-read after being annotated with the
# ids it produced, and the cards created from each piece, in the order `pieces` was sent. Every
# created card lands in `planning`, never `backlog` — a piece is a title, a task list and a
# sentence, not a plan with all six headings filled in.
contract SplitResult: {
    origin: CardDetail
    pieces: array(CardDetail)
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

# Card 0094. A sub-resource action, not `title` added to `EditCardRequest` (see the contract above):
# renaming is still the same *kind* of act `PATCH .../id` already does — a human edits stored
# content, no stage reads the field as input, nothing transitions — which is why this goes through
# `board.write` in `BoardWriteService.rename`, not `writeWithEvent` the way `move` below does. It is
# not part of `PATCH .../id` itself only because the contractkit-generated SDK method name for that
# route (`editCardBody`) is pinned to "body", and a second field would force renaming it and every
# caller for no behavioural gain.
#
# The title is not the runner state decision 5 protects, either: stage, branch and retries are
# recomputed or read by the runner itself, and `move`/`ack`/etc. are the recorded ways to override
# them. A title is authored prose nothing downstream depends on as input — the same reason `edit`
# above is allowed to touch `body` freely.
operation /api/cards/{id}/rename: {
    params: {
        id: string
    }
    post: {
        name: Rename card
        service: BoardWriteService.rename
        request: {
            application/json: RenameCardRequest
        }
        response: {
            200: {
                application/json: CardDetail
            }
            # An empty or whitespace-only title, or one whose current-title branch
            # (`WorktreeManager.branchName`) already carries commits — renaming would silently strand
            # them, since the dispatcher slugs a card's title into the branch a stage resumes.
            # Renaming to the card's current title is not an error; it is the no-op `edit` and
            # `depend` already make for their own unchanged requests. Carried via `details`, as every
            # other refusal on this surface is.
            400:
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

# Card 0091. Carries the drag an operator made in the parking lot down to a stored `position` — the
# one other thing this surface lets an operator set that is not runner state (see the comment on
# `options.security` and decision 5: the runner owns stage, branch, retries; this owns nothing the
# runner reads). Persists through `BoardRepository.setPosition`, not `write`/`writeWithEvent`: a
# reposition mints no card version and writes no `transition.written` event, on purpose — dragging a
# card three rows down did not change what the runner will do with it. Follows the same sub-resource
# shape `move` established above.
operation /api/cards/{id}/reposition: {
    params: {
        id: string
    }
    post: {
        name: Reposition card
        service: BoardWriteService.reposition
        request: {
            application/json: RepositionCardRequest
        }
        response: {
            200: {
                application/json: CardDetail
            }
            # Not in `parking-lot` — ordering any other stage is the runner's business, not an
            # operator's — or a `beforeId`/`afterId` that does not name a parking-lot card. Carried
            # via `details`, the same convention every other refusal on this surface uses.
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
                application/json: ReleaseResult
            }
            # No claim to release, or a daemon that might genuinely have the job in flight — the same
            # two refusals `wilson card release` makes before cancelling.
            400:
            404:
        }
    }
}

# Card 0113. Reads without writing: renders the division a client would confirm, before anything is
# created from it. Refuses, naming why, when there is nothing to act on rather than handing back an
# empty confirmation prompt.
operation /api/cards/{id}/division: {
    params: {
        id: string
    }
    get: {
        name: Get card division
        service: BoardWriteService.division
        response: {
            200: {
                application/json: CardDivision
            }
            # No scope-check `stage.failed` event on record for this card, or its `result.division`
            # did not survive re-parsing as a `ScopeCheckResult` — carried via `details`, the same
            # convention every other refusal on this surface uses.
            400:
            404:
        }
    }
}

# Card 0113. Creates one card per confirmed piece, in `planning`, records the dependencies named in
# each piece's `dependsOn`, and annotates the origin card with the ids it produced. Never moves or
# drops the origin — card [[0090]]'s lesson about stranding dependents applies here too, and the
# pieces themselves are what would strand — and never re-runs `scope-check` on what it creates:
# deciding a split is `scope-check`'s job (card 0105), this only acts on a division an operator
# already confirmed.
operation /api/cards/{id}/split: {
    params: {
        id: string
    }
    post: {
        name: Split card
        service: BoardWriteService.split
        request: {
            application/json: SplitCardsRequest
        }
        response: {
            201: {
                application/json: SplitResult
            }
            # Fewer than two pieces, duplicate piece titles, or a `dependsOn` that names itself or a
            # title not among the pieces being created — carried via `details`.
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

# Card 0140. A read, and nothing else: creates no session, cuts no worktree, writes nothing — `open`
# remains the only thing that seeds a draft. A card in `planning` that has never had a session open
# has no `draft.md` on disk yet; that is ordinary, not a server error, so it gets a 200 with an empty
# `body` rather than a 404 — this surface's 404 already means "no such card" (see every other
# operation here), and reusing it for "no draft yet" would leave a client unable to tell the two
# apart without inspecting `details`. [[0138]] renders an empty draft the same way it renders any
# other, with no special-case error path for a state that is completely normal.
operation /api/cards/{id}/plan/draft: {
    params: {
        id: string
    }
    get: {
        name: Get a plan draft
        service: PlanService.draft
        response: {
            200: {
                application/json: PlanDraft
            }
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

# Card 0133: one turn of the conversation the daemon can now hold for a card in `planning`, instead
# of that conversation existing only inside an operator's terminal (`wilson card plan`). This is the
# ordinary JSON half of the pair; `GET .../plan/stream` (mounted by hand beside `FeedRouter`, not
# generated — see routes.setup.ts) is where a client watches that same reply stream in as it is
# written. Refused by exactly the two guards `open` applies: a card outside `planning`, or one whose
# real branch already has work.
operation /api/cards/{id}/plan/turn: {
    params: {
        id: string
    }
    post: {
        name: Send a plan turn
        service: PlanService.turn
        request: {
            application/json: PlanTurnRequest
        }
        response: {
            200: {
                application/json: PlanTurn
            }
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
