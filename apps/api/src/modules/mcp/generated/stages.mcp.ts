// Auto-generated MCP tools
// generated from [stages.ck](../../../../data/contracts/stages.ck)
import { Injectable, type Container, type Registry } from 'injectkit';
import { z } from 'zod';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { requireMcpPolicy, type McpToolHandler, type McpToolHandlerMap, type McpToolContext } from '@maroonedsoftware/mcp';
import { PolicyService } from '@maroonedsoftware/policies';
import { parseAndValidate } from '@maroonedsoftware/zod';
import { StageConfigService } from '#modules/stages/stage.config.service.js';
import { StageConfigDocument, StageConfigVersion, StageConfigVersionsQuery } from '../../../generated/stages.js';

/** The request's scoped container, which a tool resolving per call reads its service and policies from. */
function requireMcpContainer(context: McpToolContext): Container {
    if (!context.container) {
        throw new Error(`MCP tool '${context.toolName}' needs the request container: pass \`container: ctx.container\` to createMcpRequestContext.`);
    }
    return context.container;
}

const GetStageConfigArgs = z.object({});
const ListStageConfigVersionsArgs = z.object({ query: StageConfigVersionsQuery.optional() });

/**
 * from [stages.ck](../../../../data/contracts/stages.ck) `GET /api/stages/config`
 */
@Injectable()
export class GetStageConfigMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'get_stage_config',
        inputSchema: z.toJSONSchema(GetStageConfigArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(StageConfigDocument, { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: { 'contractkit/security': { policy: 'wilson.view' } },
    };

    async handle(_args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        await requireMcpPolicy(context, container.get(PolicyService), { policy: 'wilson.view' });
        const result = await container.get(StageConfigService).get();
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
}

/**
 * from [stages.ck](../../../../data/contracts/stages.ck) `GET /api/stages/config/versions`
 */
@Injectable()
export class ListStageConfigVersionsMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'list_stage_config_versions',
        inputSchema: z.toJSONSchema(ListStageConfigVersionsArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(z.object({ items: z.array(StageConfigVersion) }), { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: { 'contractkit/security': { policy: 'wilson.view' } },
    };

    async handle(args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        await requireMcpPolicy(context, container.get(PolicyService), { policy: 'wilson.view' });
        const { query = await parseAndValidate({}, ListStageConfigVersionsArgs.shape.query.unwrap()) } = await parseAndValidate(
            args,
            ListStageConfigVersionsArgs,
        );
        const result = await container.get(StageConfigService).versions(query);
        const resultJson = JSON.stringify({ items: result });
        return { content: [{ type: 'text', text: resultJson }], structuredContent: JSON.parse(resultJson) };
    }
}

/** Add a handler for each of this file's operations to the catalog, unlisted in `tools/list`. */
export function registerStagesMcpCatalog(map: McpToolHandlerMap, container: Container): void {
    map.set('get_stage_config', container.get(GetStageConfigMcpTool));
    map.set('list_stage_config_versions', container.get(ListStageConfigVersionsMcpTool));
}

/** Register this file's tool classes on the registry, so the tool maps can resolve them. */
export function registerStagesMcpToolClasses(registry: Registry): void {
    registry.register(GetStageConfigMcpTool).useClass(GetStageConfigMcpTool).asSingleton();
    registry.register(ListStageConfigVersionsMcpTool).useClass(ListStageConfigVersionsMcpTool).asSingleton();
}
