options {
    services: {
        ChatService: "#modules/chat/chat.service.js"
        ChatAttachmentService: "#modules/chat/chat.attachment.service.js"
    }
    security: {
        policy: wilson.manage
    }
}

# The chat a person drives Wilson from, modelled on ats's web chat. Its agent reads through the
# operation catalog the other contracts generate (`McpModule`) and proposes changes; only the person's
# decision (`POST /api/chat/actions/{id}/decision`) runs one. Threads are not project-scoped: the chat
# is on every page, the project-less dashboard included, and one conversation can touch several
# projects. A message names the project of the page it was sent from instead.
#
# A question the agent asks (`ask_user`) is resolved only by the person's own act too, the same rule
# a proposed change follows: `POST .../questions/{questionId}/answers` is the one way a pending
# question moves, and nothing here guesses an answer in their name.
#
# Every operation here is `mcp: exclude`: the chat is itself the agent surface, and an agent that
# could post to its own thread, or decide its own proposals, would undo the one rule it runs under.
#
# Gated (PROJECT.md decision 10): the file's floor is `wilson.manage`, which a signed-in session
# or a `manage` API key satisfies, and every `get` lowers it to `wilson.view`, which any session
# or key does. Anything without a credential gets 401 before a handler runs.
#
# Deciding a proposal (`POST .../decision`) needs `wilson.manage` like any other change. What the chat
# can propose is the operation catalog, and nothing gated `wilson.step.up` is in it, so approving a
# chat action never stands in for a recently proved factor.

contract ChatThread: {
    id: string
    # Named after the thread's first message; the person may rename it.
    title: string
    # 'api' is the AI SDK, 'cli' the Claude Agent SDK. Fixed when the thread is made.
    engine: enum(api, cli)
    createdAt: datetime
    updatedAt: datetime
    archivedAt?: datetime
}

# One catalog operation the agent ran while answering: what the chat shows of its working.
contract ChatOperation: {
    name: string
    arguments: json
    project?: string
    ok: boolean
}

# An image sent in a chat. Metadata only, like `CardAttachment` and for its reason: the bytes come from
# `GET .../attachments/{attachmentId}`. `contentType` is the type sniffed from the bytes, never the one
# the uploader declared.
contract ChatAttachment: {
    id: string
    filename: string
    contentType: string
    byteSize: int
    contentHash: string
    createdAt: datetime
}

contract ChatMessage: {
    seq: int
    role: enum(user, assistant)
    # Markdown, for an answer.
    content: string
    operations: array(ChatOperation)
    createdAt: datetime
    # What the answer offers to ask next, left out when it offers nothing.
    suggestions?: array(string)
    # The images a person sent with this message, left out when there are none.
    attachments?: array(ChatAttachment)
}

# A change the agent proposed. `pending` until the person decides it; `running` while its operation
# runs; then `done` with its `result` or `failed` with its `error`. `declined` when the person said no.
# A pending action past `expiresAt` can no longer be confirmed.
contract ChatPendingAction: {
    id: string
    threadId: string
    project?: string
    operation: string
    arguments: json
    summary: string
    status: enum(pending, running, done, failed, declined)
    result?: json
    error?: string
    expiresAt: datetime
    decidedAt?: datetime
    createdAt: datetime
}

# One suggested answer to a `ChatQuestion`.
contract ChatQuestionOption: {
    label: string
    description: string
}

# One of the 1-4 prompts an `ask_user` call asks together, as the agent asked it.
contract ChatQuestion: {
    header: string
    text: string
    options: array(ChatQuestionOption)
    multiSelect: boolean
}

# One question's answer: the options chosen, by index into its own `options` (never by label — a
# submission is validated against the stored question, not a string match), and any "Other" text.
contract ChatQuestionAnswer: {
    chosen: array(int)
    other?: string
}

# A question the agent asked, waiting on the person. `pending` until they answer it or an ordinary
# message on the thread dismisses it (`ChatService.sendMessage`); `answered` once they submit. A
# pending question past `expiresAt` can no longer be answered.
contract ChatPendingQuestion: {
    id: string
    threadId: string
    questions: array(ChatQuestion)
    answers?: array(ChatQuestionAnswer)
    status: enum(pending, answered, dismissed)
    expiresAt: datetime
    decidedAt?: datetime
    createdAt: datetime
}

# `POST .../questions/{questionId}/answers`'s request: one answer per question asked, in order.
contract AnswerChatQuestionsRequest: {
    answers: array(ChatQuestionAnswer)
}

contract ChatThreadDetail: {
    thread: ChatThread
    messages: array(ChatMessage)
    actions: array(ChatPendingAction)
    questions: array(ChatPendingQuestion)
}

contract RenameChatThreadRequest: {
    title: string
}

# Documentation, not validation, as `AttachImageUpload` is.
contract AttachChatImageUpload: {
    file: binary
}

contract SendChatMessageRequest: {
    # May be empty when `attachments` is not.
    text: string
    # The project of the page the person is on, if any: the agent assumes it unless told otherwise.
    project?: string
    # Ids from `POST .../attachments`, each usable once, at most five. A send that fails after the
    # message was stored has used them, so a retry uploads again.
    attachments?: array(string)
}

# What one turn produced: the person's message as stored, the agent's answer, and any changes the
# answer proposed. The answer streams over `GET /api/chat/threads/{id}/stream` while this request is
# still open; this response is the stored record of it.
contract ChatTurnResult: {
    message: ChatMessage
    reply: ChatMessage
    proposed: array(ChatPendingAction)
    asked: array(ChatPendingQuestion)
}

contract DecideChatActionRequest: {
    decision: enum(confirm, decline)
}

operation /api/chat/threads: {
    get: {
        security: {
            policy: wilson.view
        }
        name: List chat threads
        mcp: exclude # The chat is itself the agent surface
        service: ChatService.listThreads
        response: {
            200: {
                application/json: array(ChatThread)
            }
        }
    }
    # Starts an empty thread on the engine the `chat-engine` setting names now; its first message
    # names it.
    post: {
        name: Start a chat thread
        mcp: exclude # The chat is itself the agent surface
        service: ChatService.startThread
        response: {
            201: {
                application/json: ChatThread
            }
        }
    }
}

operation /api/chat/threads/{id}: {
    params: {
        id: string
    }
    get: {
        security: {
            policy: wilson.view
        }
        name: Get a chat thread
        mcp: exclude # The chat is itself the agent surface
        service: ChatService.getThread
        response: {
            200: {
                application/json: ChatThreadDetail
            }
            404:
        }
    }
    patch: {
        name: Rename a chat thread
        mcp: exclude # The chat is itself the agent surface
        service: ChatService.renameThread
        request: {
            application/json: RenameChatThreadRequest
        }
        response: {
            200: {
                application/json: ChatThread
            }
            400:
            404:
        }
    }
}

# Archiving takes a thread out of the list; its messages stay.
operation /api/chat/threads/{id}/archive: {
    params: {
        id: string
    }
    post: {
        name: Archive a chat thread
        mcp: exclude # The chat is itself the agent surface
        service: ChatService.archiveThread
        response: {
            200: {
                application/json: ChatThread
            }
            404:
        }
    }
}

# Runs one turn and answers once it is stored. A turn that cannot run (no API key for the engine's
# provider, say) answers 503 with the reason, and the person's message is kept. Not 502: Cloudflare
# replaces an origin's 502 with its own page, and the reason goes with it.
operation /api/chat/threads/{id}/messages: {
    params: {
        id: string
    }
    post: {
        name: Send a chat message
        mcp: exclude # The chat is itself the agent surface
        service: ChatService.sendMessage
        request: {
            application/json: SendChatMessageRequest
        }
        response: {
            200: {
                application/json: ChatTurnResult
            }
            400:
            404:
            503:
        }
    }
}

# An image goes up before the message that carries it, so a message's send stays JSON. One that no
# message claims is removed a day later.
operation /api/chat/threads/{id}/attachments: {
    params: {
        id: string
    }
    post: {
        name: Upload a chat image
        mcp: exclude # The chat is itself the agent surface
        service: ChatAttachmentService.upload
        request: {
            multipart/form-data: AttachChatImageUpload
        }
        response: {
            200: {
                application/json: ChatAttachment
            }
            # No file part, an empty file, bytes that are not one of the four image types, or bytes
            # that disagree with the declared type. `details.reason` is that check's own sentence.
            400:
            # No thread with this id.
            404:
            # Over the per-file cap, or more than one file. The parser's own limits.
            413:
            # Not `multipart/form-data`.
            415:
        }
    }
}

# `attachmentId`, not a second `id`: a `params` block is keyed by name. One 404 covers a thread that
# does not exist and an attachment id that does not exist, belongs to another thread, or is not an id.
operation /api/chat/threads/{id}/attachments/{attachmentId}: {
    params: {
        id: string
        attachmentId: string
    }
    get: {
        security: {
            policy: wilson.view
        }
        name: Fetch a chat image
        mcp: exclude # The chat is itself the agent surface
        service: ChatAttachmentService.bytes
        response: {
            # The two headers are fixed, as on a card's attachment, so an upload can never be served
            # as something a browser will execute.
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
}

# Confirm runs the proposed operation, at most once however many times it is sent, and answers with
# how it went: a failed operation is a 200 with `status: failed` and its `error`, since the decision
# itself succeeded. A proposal already decided, or expired, is a 409.
operation /api/chat/actions/{id}/decision: {
    params: {
        id: string
    }
    post: {
        name: Decide a chat action
        mcp: exclude # Only the person decides what the chat proposed
        service: ChatService.decide
        request: {
            application/json: DecideChatActionRequest
        }
        response: {
            200: {
                application/json: ChatPendingAction
            }
            404:
            409:
        }
    }
}

# Answers a question `ask_user` asked, choosing options by index and/or typing free text under
# "Other". A valid submission moves the row to `answered` and starts a follow-up turn on the thread,
# carrying the chosen labels and any "Other" text as a note from Wilson — the same mechanism a
# confirmed change already uses (`POST .../decision`) — never a `role: 'user'` message in the
# person's name. The second path param is `questionId`, not `id`: contractkit keys a `params` block
# by name, so two `{id}` segments in one path cannot be expressed (see `.../context/{contextId}` in
# `context.ck` and `.../comments/{commentId}/resolve` in `board.ck` for the same shape). One
# consequence of nesting under the thread, which is the point of it: the same 404 below covers either
# id not existing — the thread, or a question id that does not belong to it.
operation /api/chat/threads/{id}/questions/{questionId}/answers: {
    params: {
        id: string
        questionId: string
    }
    post: {
        name: Answer chat questions
        mcp: exclude # Only the person answers what the chat asked
        service: ChatService.answerQuestions
        request: {
            application/json: AnswerChatQuestionsRequest
        }
        response: {
            200: {
                application/json: ChatPendingQuestion
            }
            # `validateAnswers` refused the submission — carried via `details`, the same convention
            # every other refusal on this surface uses.
            400:
            404:
            # Already answered, already dismissed, or past `expiresAt` — carried via `details`, the
            # same shape `.../decision`'s 409 uses for a pending action.
            409:
        }
    }
}
