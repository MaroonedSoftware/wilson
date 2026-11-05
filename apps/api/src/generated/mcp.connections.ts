import { z } from 'zod';
import { DateTime } from 'luxon';

const _ZodDatetime = z.preprocess(
    val => (typeof val === 'string' ? DateTime.fromISO(val) : val),
    z.custom<DateTime>(val => val instanceof DateTime && val.isValid, { message: 'Must be in ISO 8601 format' }),
);
type _JsonValue = string | number | boolean | null | _JsonValue[] | { [key: string]: _JsonValue };
const _ZodJson: z.ZodType<_JsonValue> = z.lazy(() =>
    z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(_ZodJson), z.record(z.string(), _ZodJson)]),
);

/**
 * How a tool may be used. `read` runs without asking, `change` runs only once a person confirms it, and
 * `disabled` is never offered. A server's own read-only hint never decides this.
 * generated from [McpToolAccess](../../data/contracts/mcp.connections.ck)
 */
export const McpToolAccess = z.enum(['read', 'change', 'disabled']);
export type McpToolAccess = z.infer<typeof McpToolAccess>;

/**
 * generated from [PutMcpConnectionRequest](../../data/contracts/mcp.connections.ck)
 */
export const PutMcpConnectionRequest = z.strictObject({
    url: z.string().describe('An http or https address serving MCP over Streamable HTTP.'),
    secret: z.string().optional(),
    project: z.string().optional(),
});
export type PutMcpConnectionRequest = z.infer<typeof PutMcpConnectionRequest>;

/**
 * generated from [McpConnectionTool](../../data/contracts/mcp.connections.ck)
 */
export const McpConnectionTool = z.strictObject({
    name: z.string(),
    description: z.string(),
    inputSchema: _ZodJson.describe('The JSON Schema of its arguments, which reaches a model as its description does.'),
    readOnlyHint: z
        .preprocess(v => (v === 'true' ? true : v === 'false' ? false : v), z.boolean())
        .describe('What the server claims. Shown to help a review, and never trusted.'),
    access: McpToolAccess,
    needsReview: z
        .preprocess(v => (v === 'true' ? true : v === 'false' ? false : v), z.boolean())
        .describe('True until a person reviews what the server lists now. A tool needing review is never offered or run.'),
});
export type McpConnectionTool = z.infer<typeof McpConnectionTool>;

/**
 * generated from [McpToolReview](../../data/contracts/mcp.connections.ck)
 */
export const McpToolReview = z.strictObject({
    name: z.string(),
    access: McpToolAccess,
});
export type McpToolReview = z.infer<typeof McpToolReview>;

/**
 * generated from [McpConnection](../../data/contracts/mcp.connections.ck)
 */
export const McpConnection = z.strictObject({
    name: z.string(),
    url: z.string(),
    secret: z.string().optional().describe('The name of the saved secret sent as its bearer token, if it takes one.'),
    project: z.string().optional().describe('The one project it may be used in. Left out, any project.'),
    tools: z.array(McpConnectionTool).describe('Name ascending.'),
    refreshedAt: _ZodDatetime,
    createdAt: _ZodDatetime,
    updatedAt: _ZodDatetime,
});
export type McpConnection = z.infer<typeof McpConnection>;

/**
 * generated from [ReviewMcpToolsRequest](../../data/contracts/mcp.connections.ck)
 */
export const ReviewMcpToolsRequest = z.strictObject({
    tools: z.array(McpToolReview),
});
export type ReviewMcpToolsRequest = z.infer<typeof ReviewMcpToolsRequest>;
