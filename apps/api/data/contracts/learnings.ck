options {
    services: {
        LearningsService: "#modules/learnings/learnings.service.js"
    }
    security: {
        policy: wilson.manage
    }
}

# A project's human-approved learnings document (card 0239) — the operator's surface, cloned from
# `stages.ck`'s `StageConfigDocument` shape: `wilson learnings show|edit|set|versions` all call
# here. Agents never read this document through this API; card 0244 materializes it for a stage
# agent a different way, and no agent runs with this API reachable as a tool in the first place
# (PROJECT.md decision 6, decision 8's own reasoning — see `stages.ck`'s comment for the fuller
# argument, which applies here unchanged).
#
# Gated (PROJECT.md decision 10): the file's floor is `wilson.manage`, which a signed-in session
# or a `manage` API key satisfies, and every `get` lowers it to `wilson.view`, which any session
# or key does. Anything without a credential gets 401 before a handler runs.
#
# Unlike stage config, a learnings document has no schema to validate — `markdown` is free text, so
# there is no `400` here, and a project with no document yet is not a failure either: `GET
# /api/learnings` answers with an empty document rather than a `404`, since an operator retiring
# every learning at once (an empty save) must read back the same way a project that never saved one
# does.
contract LearningsDocument: {
    id?: string
    markdown: string
    message: string
    createdAt?: datetime
}

# `message` optional, same reasoning as `SetStageConfigRequest`: `wilson learnings edit` has no
# commit-message prompt the way `git commit` does, and a default ("Edited learnings") beats forcing
# one.
contract SetLearningsRequest: {
    markdown: string
    message?: string
}

contract LearningsVersion: {
    id: string
    message: string
    createdAt: datetime
}

contract LearningsVersionsQuery: {
    limit?: int
}

operation /api/learnings: {
    get: {
        security: {
            policy: wilson.view
        }
        name: Get learnings
        service: LearningsService.get
        response: {
            200: {
                application/json: LearningsDocument
            }
        }
    }
    # `put`, not `patch`: the document is replaced whole. Every save is a new row; the previous
    # document is still there in the history, so a bad edit is undone by saving the earlier text
    # again, never by deleting anything. An empty `markdown` is a valid save.
    put: {
        name: Set learnings
        service: LearningsService.set
        request: {
            application/json: SetLearningsRequest
        }
        response: {
            200: {
                application/json: LearningsDocument
            }
        }
    }
}

operation /api/learnings/versions: {
    get: {
        security: {
            policy: wilson.view
        }
        name: List learnings versions
        service: LearningsService.versions
        query: LearningsVersionsQuery
        response: {
            200: {
                application/json: array(LearningsVersion)
            }
        }
    }
}
