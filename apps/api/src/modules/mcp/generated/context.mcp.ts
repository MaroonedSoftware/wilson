// Auto-generated MCP tools
// generated from [context.ck](../../../../data/contracts/context.ck)
import { Injectable, type Container, type Registry } from 'injectkit';
import { z } from 'zod';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { requireMcpPolicy, type McpToolHandler, type McpToolHandlerMap, type McpToolContext } from '@maroonedsoftware/mcp';
import { PolicyService } from '@maroonedsoftware/policies';
import { parseAndValidate } from '@maroonedsoftware/zod';
import { ContextService } from '#modules/context/context.service.js';
import { AttachContextRequest, ContextSnapshot } from '../../../generated/context.js';

/** The request's scoped container, which a tool resolving per call reads its service and policies from. */
function requireMcpContainer(context: McpToolContext): Container {
    if (!context.container) {
        throw new Error(`MCP tool '${context.toolName}' needs the request container: pass \`container: ctx.container\` to createMcpRequestContext.`);
    }
    return context.container;
}

const AttachContextToACardArgs = z.object({ id: z.string(), body: AttachContextRequest });
const ListCardContextArgs = z.object({ id: z.string() });
const RemoveAContextSnapshotArgs = z.object({ id: z.string(), contextId: z.string() });

/**
 * from [context.ck](../../../../data/contracts/context.ck) `POST /api/cards/{id}/context`
 */
@Injectable()
export class AttachContextToACardMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'attach_context_to_a_card',
        inputSchema: z.toJSONSchema(AttachContextToACardArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(ContextSnapshot, { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        _meta: { 'contractkit/security': { policy: 'wilson.manage' } },
    };

    async handle(args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        await requireMcpPolicy(context, container.get(PolicyService), { policy: 'wilson.manage' });
        const { id, body } = await parseAndValidate(args, AttachContextToACardArgs);
        const result = await container.get(ContextService).attach(id, body);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
}

/**
 * from [context.ck](../../../../data/contracts/context.ck) `GET /api/cards/{id}/context`
 */
@Injectable()
export class ListCardContextMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'list_card_context',
        inputSchema: z.toJSONSchema(ListCardContextArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(z.object({ items: z.array(ContextSnapshot) }), { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: { 'contractkit/security': { policy: 'wilson.view' } },
    };

    async handle(args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        await requireMcpPolicy(context, container.get(PolicyService), { policy: 'wilson.view' });
        const { id } = await parseAndValidate(args, ListCardContextArgs);
        const result = await container.get(ContextService).list(id);
        const resultJson = JSON.stringify({ items: result });
        return { content: [{ type: 'text', text: resultJson }], structuredContent: JSON.parse(resultJson) };
    }
}

/**
 * from [context.ck](../../../../data/contracts/context.ck) `DELETE /api/cards/{id}/context/{contextId}`
 */
@Injectable()
export class RemoveAContextSnapshotMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'remove_a_context_snapshot',
        description:
            "`delete`, not `post .../remove`: contractkit emits a DELETE handler like any other method, so\nthere is no reason to reach for the `/resolve`-style action suffix `board.ck` uses only where the\nverb genuinely isn't one of the four HTTP methods this repo's contracts use elsewhere. A snapshot\nhas no history worth keeping once removed (`CardContextRepository.remove`'s own doc comment), so\nunlike `.../plan/comments/{commentId}/resolve` this is a real delete, not a state transition.",
        inputSchema: z.toJSONSchema(RemoveAContextSnapshotArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        _meta: { 'contractkit/security': { policy: 'wilson.manage' } },
    };

    async handle(args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        await requireMcpPolicy(context, container.get(PolicyService), { policy: 'wilson.manage' });
        const { id, contextId } = await parseAndValidate(args, RemoveAContextSnapshotArgs);
        await container.get(ContextService).remove(id, contextId);
        return { content: [{ type: 'text', text: 'OK' }] };
    }
}

/** Add a handler for each of this file's operations to the catalog, unlisted in `tools/list`. */
export function registerContextMcpCatalog(map: McpToolHandlerMap, container: Container): void {
    map.set('attach_context_to_a_card', container.get(AttachContextToACardMcpTool));
    map.set('list_card_context', container.get(ListCardContextMcpTool));
    map.set('remove_a_context_snapshot', container.get(RemoveAContextSnapshotMcpTool));
}

/** Register this file's tool classes on the registry, so the tool maps can resolve them. */
export function registerContextMcpToolClasses(registry: Registry): void {
    registry.register(AttachContextToACardMcpTool).useClass(AttachContextToACardMcpTool).asSingleton();
    registry.register(ListCardContextMcpTool).useClass(ListCardContextMcpTool).asSingleton();
    registry.register(RemoveAContextSnapshotMcpTool).useClass(RemoveAContextSnapshotMcpTool).asSingleton();
}
