// Auto-generated MCP tools
// generated from [code.ck](../../../../data/contracts/code.ck)
import { Injectable, type Container, type Registry } from 'injectkit';
import { z } from 'zod';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { requireMcpPolicy, type McpToolHandler, type McpToolHandlerMap, type McpToolContext } from '@maroonedsoftware/mcp';
import { PolicyService } from '@maroonedsoftware/policies';
import { parseAndValidate } from '@maroonedsoftware/zod';
import { CodeService } from '#modules/code/code.service.js';
import { CodeFilePage, CodeListQuery, CodeListing, CodeReadQuery, CodeSearchQuery, CodeSearchResult } from '../../../generated/code.js';

/** The request's scoped container, which a tool resolving per call reads its service and policies from. */
function requireMcpContainer(context: McpToolContext): Container {
    if (!context.container) {
        throw new Error(`MCP tool '${context.toolName}' needs the request container: pass \`container: ctx.container\` to createMcpRequestContext.`);
    }
    return context.container;
}

const ListProjectCodeArgs = z.object({ query: CodeListQuery.optional() });
const ReadProjectFileArgs = z.object({ query: CodeReadQuery.optional() });
const SearchProjectCodeArgs = z.object({ query: CodeSearchQuery.optional() });

/**
 * from [code.ck](../../../../data/contracts/code.ck) `GET /api/code/tree`
 */
@Injectable()
export class ListProjectCodeMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'list_project_code',
        inputSchema: z.toJSONSchema(ListProjectCodeArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(CodeListing, { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: { 'contractkit/security': { policy: 'wilson.view' } },
    };

    async handle(args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        await requireMcpPolicy(context, container.get(PolicyService), { policy: 'wilson.view' });
        const { query = await parseAndValidate({}, ListProjectCodeArgs.shape.query.unwrap()) } = await parseAndValidate(args, ListProjectCodeArgs);
        const result = await container.get(CodeService).list(query);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
}

/**
 * from [code.ck](../../../../data/contracts/code.ck) `GET /api/code/file`
 */
@Injectable()
export class ReadProjectFileMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'read_project_file',
        inputSchema: z.toJSONSchema(ReadProjectFileArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(CodeFilePage, { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: { 'contractkit/security': { policy: 'wilson.view' } },
    };

    async handle(args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        await requireMcpPolicy(context, container.get(PolicyService), { policy: 'wilson.view' });
        const { query = await parseAndValidate({}, ReadProjectFileArgs.shape.query.unwrap()) } = await parseAndValidate(args, ReadProjectFileArgs);
        const result = await container.get(CodeService).read(query);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
}

/**
 * from [code.ck](../../../../data/contracts/code.ck) `GET /api/code/search`
 */
@Injectable()
export class SearchProjectCodeMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'search_project_code',
        inputSchema: z.toJSONSchema(SearchProjectCodeArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(CodeSearchResult, { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: { 'contractkit/security': { policy: 'wilson.view' } },
    };

    async handle(args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        await requireMcpPolicy(context, container.get(PolicyService), { policy: 'wilson.view' });
        const { query = await parseAndValidate({}, SearchProjectCodeArgs.shape.query.unwrap()) } = await parseAndValidate(
            args,
            SearchProjectCodeArgs,
        );
        const result = await container.get(CodeService).search(query);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
}

/** Add a handler for each of this file's operations to the catalog, unlisted in `tools/list`. */
export function registerCodeMcpCatalog(map: McpToolHandlerMap, container: Container): void {
    map.set('list_project_code', container.get(ListProjectCodeMcpTool));
    map.set('read_project_file', container.get(ReadProjectFileMcpTool));
    map.set('search_project_code', container.get(SearchProjectCodeMcpTool));
}

/** Register this file's tool classes on the registry, so the tool maps can resolve them. */
export function registerCodeMcpToolClasses(registry: Registry): void {
    registry.register(ListProjectCodeMcpTool).useClass(ListProjectCodeMcpTool).asSingleton();
    registry.register(ReadProjectFileMcpTool).useClass(ReadProjectFileMcpTool).asSingleton();
    registry.register(SearchProjectCodeMcpTool).useClass(SearchProjectCodeMcpTool).asSingleton();
}
