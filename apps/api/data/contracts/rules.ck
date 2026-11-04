options {
    services: {
        RulesService: "#modules/rules/rules.service.js"
    }
    security: {
        policy: wilson.manage
    }
}

# A project's checked rules: things a person decided must hold in its code, each judged on its own by
# a fresh model call at review (`RuleJudge`). Learnings are advice nothing checks; these are checked.
#
# Gated (PROJECT.md decision 10): the file's floor is `wilson.manage`, and every `get` lowers it to
# `wilson.view`. Rules are the machinery PROJECT.md decision 8 keeps human-write-only, because an agent
# that can rewrite what it is judged by passes every time. So every write needs `wilson.step.up`, which
# no API key ever is, and none of them is offered through MCP.

# `revision` is the newest `wilson.rule_revisions` id, which a verdict is keyed on.
contract Rule: {
    id: string
    statement: string
    paths: array(string)
    severity: enum(blocker, concern)
    revision: string
    createdAt: datetime
    updatedAt: datetime
}

contract CreateRuleRequest: {
    id: string
    statement: string
    paths: array(string)
    severity?: enum(blocker, concern)
    message?: string
}

# Only what changes.
contract PatchRuleRequest: {
    statement?: string
    paths?: array(string)
    severity?: enum(blocker, concern)
    message?: string
}

contract DeleteRuleQuery: {
    message?: string
}

# One change to a rule. No `snapshot` means the rule was removed.
contract RuleRevision: {
    id: string
    rule: string
    snapshot?: json
    message: string
    createdAt: datetime
}

contract RuleRevisionsQuery: {
    rule?: string
    limit?: int
}

operation /api/rules: {
    get: {
        security: {
            policy: wilson.view
        }
        name: List rules
        service: RulesService.list
        response: {
            200: {
                application/json: array(Rule)
            }
        }
    }
    post: {
        name: Create rule
        mcp: exclude # Human-write-only machinery (PROJECT.md decision 8): set with `wilson rules add`
        service: RulesService.create
        security: {
            policy: wilson.step.up
        }
        request: {
            application/json: CreateRuleRequest
        }
        response: {
            201: {
                application/json: Rule
            }
            # A malformed id, an empty statement or a glob that cannot match. The reason is in `details`.
            400:
            # A rule with that id already exists.
            409:
        }
    }
}

operation /api/rules/revisions: {
    get: {
        security: {
            policy: wilson.view
        }
        name: List rule revisions
        service: RulesService.revisions
        query: RuleRevisionsQuery
        response: {
            200: {
                application/json: array(RuleRevision)
            }
        }
    }
}

operation /api/rules/{id}: {
    params: {
        id: string
    }
    patch: {
        name: Update rule
        mcp: exclude # Human-write-only machinery (PROJECT.md decision 8): set with `wilson rules edit`
        service: RulesService.update
        security: {
            policy: wilson.step.up
        }
        request: {
            application/json: PatchRuleRequest
        }
        response: {
            200: {
                application/json: Rule
            }
            400:
            404:
        }
    }
    delete: {
        name: Delete rule
        mcp: exclude # Human-write-only machinery (PROJECT.md decision 8): set with `wilson rules rm`
        service: RulesService.remove
        security: {
            policy: wilson.step.up
        }
        query: DeleteRuleQuery
        response: {
            204:
            404:
        }
    }
}
