// Auto-generated MCP tools
// generated from [health.ck](../../../../data/contracts/health.ck)
import { Injectable, type Container, type Registry } from 'injectkit';
import { z } from 'zod';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { McpToolHandler, McpToolHandlerMap, McpToolContext } from '@maroonedsoftware/mcp';
import { HealthService } from '#modules/health/health.service.js';
import { Health } from '../../../generated/health.js';

/** The request's scoped container, which a tool resolving per call reads its service and policies from. */
function requireMcpContainer(context: McpToolContext): Container {
    if (!context.container) {
        throw new Error(`MCP tool '${context.toolName}' needs the request container: pass \`container: ctx.container\` to createMcpRequestContext.`);
    }
    return context.container;
}

const GetHealthArgs = z.object({});

/**
 * from [health.ck](../../../../data/contracts/health.ck) `GET /api/health`
 */
@Injectable()
export class GetHealthMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'get_health',
        inputSchema: z.toJSONSchema(GetHealthArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(Health, { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: { 'contractkit/security': 'none' },
    };

    async handle(_args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        const result = await container.get(HealthService).get();
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
}

/** Add a handler for each of this file's operations to the catalog, unlisted in `tools/list`. */
export function registerHealthMcpCatalog(map: McpToolHandlerMap, container: Container): void {
    map.set('get_health', container.get(GetHealthMcpTool));
}

/** Register this file's tool classes on the registry, so the tool maps can resolve them. */
export function registerHealthMcpToolClasses(registry: Registry): void {
    registry.register(GetHealthMcpTool).useClass(GetHealthMcpTool).asSingleton();
}
