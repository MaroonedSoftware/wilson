import { DateTime } from 'luxon';
import type { JsonValue } from '../sdk-options.js';

const __dt = (v: unknown, path: string): DateTime => {
    if (typeof v !== 'string') {
        throw new TypeError(`ContractKit: expected an ISO 8601 string at '${path}', received ${typeof v}.`);
    }
    const d = DateTime.fromISO(v);
    if (!d.isValid) throw new TypeError(`ContractKit: '${v}' at '${path}' is not a valid ISO 8601 datetime.`);
    return d;
};

/**
 * How a tool may be used. `read` runs without asking, `change` runs only once a person confirms it, and
 * `disabled` is never offered. A server's own read-only hint never decides this.
 * generated from [McpToolAccess](../../../../apps/api/data/contracts/mcp.connections.ck)
 */
export type McpToolAccess = 'read' | 'change' | 'disabled';

/**
 * generated from [PutMcpConnectionRequest](../../../../apps/api/data/contracts/mcp.connections.ck)
 */
export interface PutMcpConnectionRequest {
    /** An http or https address serving MCP over Streamable HTTP. */
    url: string;
    secret?: string;
    project?: string;
}

/**
 * generated from [McpConnectionTool](../../../../apps/api/data/contracts/mcp.connections.ck)
 */
export interface McpConnectionTool {
    name: string;
    description: string;
    /** The JSON Schema of its arguments, which reaches a model as its description does. */
    inputSchema: JsonValue;
    /** What the server claims. Shown to help a review, and never trusted. */
    readOnlyHint: boolean;
    access: McpToolAccess;
    /** True until a person reviews what the server lists now. A tool needing review is never offered or run. */
    needsReview: boolean;
}

/**
 * generated from [McpToolReview](../../../../apps/api/data/contracts/mcp.connections.ck)
 */
export interface McpToolReview {
    name: string;
    access: McpToolAccess;
}

/**
 * generated from [McpConnection](../../../../apps/api/data/contracts/mcp.connections.ck)
 */
export interface McpConnection {
    name: string;
    url: string;
    /** The name of the saved secret sent as its bearer token, if it takes one. */
    secret?: string;
    /** The one project it may be used in. Left out, any project. */
    project?: string;
    /** Name ascending. */
    tools: McpConnectionTool[];
    refreshedAt: DateTime;
    createdAt: DateTime;
    updatedAt: DateTime;
}

/** Rehydrates every wire-encoded scalar in a McpConnection into its runtime type. Mutates and returns `raw`. */
export function reviveMcpConnection(raw: McpConnection): McpConnection {
    const __o0 = raw as unknown as Record<string, unknown>;
    __o0['refreshedAt'] = __dt(__o0['refreshedAt'], 'McpConnection.refreshedAt');
    __o0['createdAt'] = __dt(__o0['createdAt'], 'McpConnection.createdAt');
    __o0['updatedAt'] = __dt(__o0['updatedAt'], 'McpConnection.updatedAt');
    return raw;
}

/**
 * generated from [ReviewMcpToolsRequest](../../../../apps/api/data/contracts/mcp.connections.ck)
 */
export interface ReviewMcpToolsRequest {
    tools: McpToolReview[];
}
