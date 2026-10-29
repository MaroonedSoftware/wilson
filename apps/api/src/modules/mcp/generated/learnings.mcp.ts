// Auto-generated MCP tools
// generated from [learnings.ck](../../../../data/contracts/learnings.ck)
import { Injectable, type Container, type Registry } from 'injectkit';
import { z } from 'zod';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { McpToolHandler, McpToolHandlerMap, McpToolContext } from '@maroonedsoftware/mcp';
import { parseAndValidate } from '@maroonedsoftware/zod';
import { LearningsService } from '#modules/learnings/learnings.service.js';
import { LearningsDocument, LearningsVersion, LearningsVersionsQuery } from '../../../generated/learnings.js';

/** The request's scoped container, which a tool resolving per call reads its service and policies from. */
function requireMcpContainer(context: McpToolContext): Container {
    if (!context.container) {
        throw new Error(`MCP tool '${context.toolName}' needs the request container: pass \`container: ctx.container\` to createMcpRequestContext.`);
    }
    return context.container;
}

const GetLearningsArgs = z.object({});
const ListLearningsVersionsArgs = z.object({ query: LearningsVersionsQuery.optional() });

/**
 * from [learnings.ck](../../../../data/contracts/learnings.ck) `GET /api/learnings`
 */
@Injectable()
export class GetLearningsMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'get_learnings',
        inputSchema: z.toJSONSchema(GetLearningsArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(LearningsDocument, { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: { 'contractkit/security': 'none' },
    };

    async handle(_args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        const result = await container.get(LearningsService).get();
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
}

/**
 * from [learnings.ck](../../../../data/contracts/learnings.ck) `GET /api/learnings/versions`
 */
@Injectable()
export class ListLearningsVersionsMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'list_learnings_versions',
        inputSchema: z.toJSONSchema(ListLearningsVersionsArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(z.object({ items: z.array(LearningsVersion) }), { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: { 'contractkit/security': 'none' },
    };

    async handle(args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        const { query = await parseAndValidate({}, ListLearningsVersionsArgs.shape.query.unwrap()) } = await parseAndValidate(
            args,
            ListLearningsVersionsArgs,
        );
        const result = await container.get(LearningsService).versions(query);
        const resultJson = JSON.stringify({ items: result });
        return { content: [{ type: 'text', text: resultJson }], structuredContent: JSON.parse(resultJson) };
    }
}

/** Add a handler for each of this file's operations to the catalog, unlisted in `tools/list`. */
export function registerLearningsMcpCatalog(map: McpToolHandlerMap, container: Container): void {
    map.set('get_learnings', container.get(GetLearningsMcpTool));
    map.set('list_learnings_versions', container.get(ListLearningsVersionsMcpTool));
}

/** Register this file's tool classes on the registry, so the tool maps can resolve them. */
export function registerLearningsMcpToolClasses(registry: Registry): void {
    registry.register(GetLearningsMcpTool).useClass(GetLearningsMcpTool).asSingleton();
    registry.register(ListLearningsVersionsMcpTool).useClass(ListLearningsVersionsMcpTool).asSingleton();
}
