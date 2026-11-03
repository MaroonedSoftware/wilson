options {
    services: {
        ContextService: "#modules/context/context.service.js"
        AttachmentService: "#modules/context/attachment.service.js"
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

# An image kept on a card (split from card 0006). Metadata only: the bytes are a `BYTEA` column on
# `wilson.card_attachments`, for the reason that migration's header gives, and they are not in this
# contract because a card at its 20 MB cap must still list as a small JSON response. One attachment's
# bytes come from `GET .../attachments/{attachmentId}`. `contentType` is the type sniffed from the
# bytes, never the one the uploader declared.
contract CardAttachment: {
    id: string
    filename: string
    contentType: string
    byteSize: int
    contentHash: string
    addedBy: string
    createdAt: datetime
}

# Documentation, not validation: a multipart body reaches `AttachmentService.attach` as the parser's
# own `MultipartBody`, and the SDK types it as `FormData`, so nothing checks this shape.
contract AttachImageUpload: {
    file: binary
}

operation /api/cards/{id}/attachments: {
    params: {
        id: string
    }
    post: {
        name: Attach an image to a card
        service: AttachmentService.attach
        mcp: exclude # isCatalogOperation refuses a multipart request body, and an agent cannot produce image bytes
        request: {
            multipart/form-data: AttachImageUpload
        }
        response: {
            200: {
                application/json: CardAttachment
            }
            # No file part, an empty file, bytes that are not one of the four image types, bytes that
            # disagree with the declared type, or a card at its count or total-bytes cap.
            # `details.reason` is that check's own sentence.
            400:
            # No card with this id.
            404:
            # Over the per-file cap, or more than one file. The parser's own limits.
            413:
            # Not `multipart/form-data`. `assertBodyExpectation` answers this before the handler runs.
            415:
        }
    }
    get: {
        security: {
            policy: wilson.view
        }
        name: List card attachments
        service: AttachmentService.list
        response: {
            200: {
                application/json: array(CardAttachment)
            }
            404:
        }
    }
}

# `attachmentId`, not a second `id`, for the reason `{contextId}` above has: a `params` block is keyed
# by name. Nesting under the card lets one 404 cover a card that does not exist and an attachment id
# that does not exist, belongs to another card, or is not an id at all.
operation /api/cards/{id}/attachments/{attachmentId}: {
    params: {
        id: string
        attachmentId: string
    }
    get: {
        security: {
            policy: wilson.view
        }
        name: Fetch an attachment
        service: AttachmentService.bytes
        mcp: exclude # isCatalogOperation refuses a non-JSON response body
        response: {
            # The two headers are fixed, so an upload can never be served as something a browser
            # will execute. SVG is not among these types for the same reason.
            200: {
                image/png: binary
                image/jpeg: binary
                image/webp: binary
                image/gif: binary
                headers: {
                    x-content-type-options: string
                    content-security-policy: string
                }
            }
            404:
        }
    }
    delete: {
        name: Remove an attachment
        service: AttachmentService.remove
        response: {
            204:
            404:
        }
    }
}
