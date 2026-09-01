options {
    services: {
        StageConfigService: "#modules/stages/stage.config.service.js"
    }
    security: none
}

# The stage config document itself — the operator's surface, beside `board.ck`'s `GET /api/stages`,
# which exposes only the column names a board client needs. Stage config used to be
# `config/stages.yaml` in the sibling board repo, edited in place and committed there; it is a
# `runner.stage_configs` row now (`StageConfigStore`, apps/api/src/modules/stages), so this is how it
# is read and written: `wilson stages show|edit|set|versions` all call here.
#
# `security: none` for the reason board.ck, settings.ck and projects.ck already state: the API binds
# to 127.0.0.1 with no auth boundary yet (card 0019). Worth saying plainly for this file in
# particular, though — the stage config is exactly the thing PROJECT.md decision 8 keeps
# human-write-only, because an agent that can rewrite its own exit condition passes every time.
# What enforces that is not this endpoint's absence of auth; it is that no agent runs with the API
# reachable as a tool: the write tool denies `**/stages.yaml` by name still, the bash tool runs only
# an allowlisted argv prefix (no `curl`), and the board is unreachable from a worktree by
# construction (decision 6). Authenticating the API is card 0019's job, and the day this listens on
# anything but localhost this operation is the first that needs it.

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

operation /api/stages/config: {
    get: {
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
        service: StageConfigService.set
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
