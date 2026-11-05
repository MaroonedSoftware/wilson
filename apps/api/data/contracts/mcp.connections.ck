options {
    services: {
        McpConnectionsService: "#modules/connections/mcp.connections.service.js"
    }
    security: {
        policy: wilson.step.up
    }
}

# Outside MCP servers Wilson connects to (`wilson.mcp_connections`). Wilson is the only client, and a
# server's credential is a saved secret that nothing here returns.
#
# The floor is `wilson.step.up`, because a connection and its reviewed tools are authority handed to
# whatever can call them. Every operation is `mcp: exclude`, so no agent can add a server or widen what
# it may call (PROJECT.md decision 8).

# How a tool may be used. `read` runs without asking, `change` runs only once a person confirms it, and
# `disabled` is never offered. A server's own read-only hint never decides this.
contract McpToolAccess: enum(read, change, disabled)

contract McpConnectionTool: {
    name: string
    description: string
    # The JSON Schema of its arguments, which reaches a model as its description does.
    inputSchema: json
    # What the server claims. Shown to help a review, and never trusted.
    readOnlyHint: boolean
    access: McpToolAccess
    # True until a person reviews what the server lists now. A tool needing review is never offered or run.
    needsReview: boolean
}

contract McpConnection: {
    name: string
    url: string
    # The name of the saved secret sent as its bearer token, if it takes one.
    secret?: string
    # The one project it may be used in. Left out, any project.
    project?: string
    # Name ascending.
    tools: array(McpConnectionTool)
    refreshedAt: datetime
    createdAt: datetime
    updatedAt: datetime
}

contract PutMcpConnectionRequest: {
    # An http or https address serving MCP over Streamable HTTP.
    url: string
    secret?: string
    project?: string
}

contract McpToolReview: {
    name: string
    access: McpToolAccess
}

contract ReviewMcpToolsRequest: {
    tools: array(McpToolReview)
}

operation /api/mcp-connections: {
    get: {
        mcp: exclude # Which servers exist is not an agent's business
        security: {
            policy: wilson.view
        }
        name: List MCP connections
        service: McpConnectionsService.list
        response: {
            200: {
                application/json: array(McpConnection)
            }
        }
    }
}

operation /api/mcp-connections/{name}: {
    params: {
        name: string
    }
    # Connect to a server and list its tools, saving nothing if that fails. Replaces any connection saved
    # under `name`. A new address forgets every review, since it may be another server. No tool is
    # usable until it is reviewed.
    put: {
        mcp: exclude # An agent cannot add a server
        name: Put MCP connection
        service: McpConnectionsService.put
        request: {
            application/json: PutMcpConnectionRequest
        }
        response: {
            200: {
                application/json: McpConnection
            }
            # A bad name or address, an unknown secret or project, or a server that could not be listed.
            400:
        }
    }
    delete: {
        mcp: exclude # An agent cannot change its own reach
        name: Remove MCP connection
        service: McpConnectionsService.remove
        response: {
            204:
            404:
        }
    }
}

operation /api/mcp-connections/{name}/refresh: {
    params: {
        name: string
    }
    # List the server's tools again. Anything it now describes differently stops being usable until it is
    # reviewed. Lowered to `wilson.manage`, since this can only take authority away.
    post: {
        mcp: exclude # Which servers exist is not an agent's business
        security: {
            policy: wilson.manage
        }
        name: Refresh MCP connection
        service: McpConnectionsService.refresh
        response: {
            200: {
                application/json: McpConnection
            }
            # The server could not be listed.
            400:
            404:
        }
    }
}

operation /api/mcp-connections/{name}/tools: {
    params: {
        name: string
    }
    # Decide how each named tool may be used, approving what it is described as now. Tools left out stay
    # as they are.
    put: {
        mcp: exclude # An agent cannot widen what it may call
        name: Review MCP tools
        service: McpConnectionsService.review
        request: {
            application/json: ReviewMcpToolsRequest
        }
        response: {
            200: {
                application/json: McpConnection
            }
            # A tool the server does not list.
            400:
            404:
        }
    }
}
