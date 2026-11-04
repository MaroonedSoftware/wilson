options {
    services: {
        RulesService: "#modules/rules/rules.service.js"
        RuleProposalService: "#modules/rules/rule.proposal.service.js"
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

# What to check: `branch`'s diff from its merge base with `base`, which is what the project's code root
# has checked out when left out.
contract RuleCheckRequest: {
    branch: string
    base?: string
}

contract RuleCheckVerdict: {
    rule: string
    revision: string
    statement: string
    severity: enum(blocker, concern)
    paths: array(string)
    verdict: enum(pass, fail, unavailable)
    file?: string
    line?: int
    evidence: string
    reused: boolean
}

contract RuleCheckUsage: {
    inputTokens?: int
    cachedInputTokens?: int
    cacheWriteInputTokens?: int
    outputTokens?: int
}

contract RuleCheckReport: {
    branch: string
    mergeBase: string
    verdicts: array(RuleCheckVerdict)
    usage?: RuleCheckUsage
}

# A rule a model drafted from a blocker that survived challenge and sent a card back. It is nothing until
# a person accepts it, and stops being offered after 45 days.
contract RuleProposal: {
    id: string
    cardId: string
    statement: string
    paths: array(string)
    reason: string
    expiresAt: datetime
    createdAt: datetime
}

# What the rule is called, which a person chooses, and any words they changed.
contract AcceptRuleProposalRequest: {
    id: string
    statement?: string
    paths?: array(string)
    severity?: enum(blocker, concern)
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

operation /api/rules/proposals: {
    get: {
        security: {
            policy: wilson.view
        }
        name: List rule proposals
        service: RuleProposalService.list
        response: {
            200: {
                application/json: array(RuleProposal)
            }
        }
    }
}

operation /api/rules/proposals/{id}/accept: {
    params: {
        id: string
    }
    post: {
        name: Accept rule proposal
        mcp: exclude # Human-write-only machinery (PROJECT.md decision 8): this writes a rule.
        service: RuleProposalService.accept
        security: {
            policy: wilson.step.up
        }
        request: {
            application/json: AcceptRuleProposalRequest
        }
        response: {
            200: {
                application/json: Rule
            }
            # A malformed rule. The proposal stays pending. The reason is in `details`.
            400:
            # No such proposal waiting: already decided, expired or never there, or the id is taken.
            409:
        }
    }
}

operation /api/rules/proposals/{id}/decline: {
    params: {
        id: string
    }
    post: {
        name: Decline rule proposal
        mcp: exclude # A person must decide (PROJECT.md decision 8).
        service: RuleProposalService.decline
        response: {
            204:
            # No such proposal waiting: already decided, expired or never there.
            409:
        }
    }
}

operation /api/rules/check: {
    post: {
        name: Check rules
        mcp: exclude # Spends a model call per matching rule, which a person decides to do.
        service: RulesService.check
        request: {
            application/json: RuleCheckRequest
        }
        response: {
            200: {
                application/json: RuleCheckReport
            }
            # No such branch or base. The reason is in `details`.
            400:
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
