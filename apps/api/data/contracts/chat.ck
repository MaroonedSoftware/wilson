options {
    services: {
        ChatService: "#modules/chat/chat.service.js"
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

contract ChatMessage: {
    seq: int
    role: enum(user, assistant)
    # Markdown, for an answer.
    content: string
    operations: array(ChatOperation)
    createdAt: datetime
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

contract ChatThreadDetail: {
    thread: ChatThread
    messages: array(ChatMessage)
    actions: array(ChatPendingAction)
}

contract RenameChatThreadRequest: {
    title: string
}

contract SendChatMessageRequest: {
    text: string
    # The project of the page the person is on, if any: the agent assumes it unless told otherwise.
    project?: string
}

# What one turn produced: the person's message as stored, the agent's answer, and any changes the
# answer proposed. The answer streams over `GET /api/chat/threads/{id}/stream` while this request is
# still open; this response is the stored record of it.
contract ChatTurnResult: {
    message: ChatMessage
    reply: ChatMessage
    proposed: array(ChatPendingAction)
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
# provider, say) answers 502 with the reason, and the person's message is kept.
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
            502:
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
