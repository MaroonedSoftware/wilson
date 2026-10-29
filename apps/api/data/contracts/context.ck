options {
    services: {
        ContextService: "#modules/context/context.service.js"
    }
    security: {
        policy: wilson.manage
    }
}

# Gated (PROJECT.md decision 10): the file's floor is `wilson.manage`, which a signed-in session
# or a `manage` API key satisfies, and every `get` lowers it to `wilson.view`, which any session
# or key does. Anything without a credential gets 401 before a handler runs.

# Third of six in the context-provider slice (PROJECT.md, "Context providers"). `wilson.card_context`
# (card 0185) is where a snapshot lives; `ContextProvider`/`ContextProviderRegistry`/
# `UrlContextProvider` (card 0186) is how one gets fetched. This is the seam between them: attaching a
# document to a card, over HTTP.
#
# `fetchedAt` and `createdAt` are both `datetime` and are not redundant — see the migration's own
# header comment (`data/migrations/20261029000500_board.sql`): `fetchedAt` is when the source
# said the content was current, `createdAt` is when this row was written.
contract ContextSnapshot: {
    id: string
    sourceUrl: string
    fetchedAt: datetime
    fetchedBy: string
    title?: string
    content: string
    contentHash: string
    createdAt: datetime
}

# `POST .../context`'s request: the URL to fetch, nothing else. `fetchedBy` is not a field here —
# it is always `'human'` on this surface (this card's Constraints), never something a caller chooses.
contract AttachContextRequest: {
    sourceUrl: string
}

operation /api/cards/{id}/context: {
    params: {
        id: string
    }
    post: {
        name: Attach context to a card
        service: ContextService.attach
        request: {
            application/json: AttachContextRequest
        }
        response: {
            200: {
                application/json: ContextSnapshot
            }
            # `sourceUrl` names no registered provider, or the provider that would handle it refused
            # the fetch — a private address, a redirect, a timeout, an oversized body, an upstream
            # error. `details.reason` is that refusal's own sentence, never collapsed to one message.
            400:
            # No card with this id.
            404:
        }
    }
    get: {
        security: {
            policy: wilson.view
        }
        name: List card context
        service: ContextService.list
        response: {
            200: {
                application/json: array(ContextSnapshot)
            }
            404:
        }
    }
}

# `delete`, not `post .../remove`: contractkit emits a DELETE handler like any other method, so
# there is no reason to reach for the `/resolve`-style action suffix `board.ck` uses only where the
# verb genuinely isn't one of the four HTTP methods this repo's contracts use elsewhere. A snapshot
# has no history worth keeping once removed (`CardContextRepository.remove`'s own doc comment), so
# unlike `.../plan/comments/{commentId}/resolve` this is a real delete, not a state transition.
operation /api/cards/{id}/context/{contextId}: {
    params: {
        id: string
        contextId: string
    }
    delete: {
        name: Remove a context snapshot
        service: ContextService.remove
        response: {
            204:
            # Either id not existing — the card, or a snapshot id not belonging to it — the same
            # 404 `board.ck`'s `.../comments/{commentId}/resolve` gives for the same shape of miss.
            404:
        }
    }
}
