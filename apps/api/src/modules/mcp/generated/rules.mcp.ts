// Auto-generated MCP tools
// generated from [rules.ck](../../../../data/contracts/rules.ck)
import { Injectable, type Container, type Registry } from 'injectkit';
import { z } from 'zod';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { requireMcpPolicy, type McpToolHandler, type McpToolHandlerMap, type McpToolContext } from '@maroonedsoftware/mcp';
import { PolicyService } from '@maroonedsoftware/policies';
import { parseAndValidate } from '@maroonedsoftware/zod';
import { RuleProposalService } from '#modules/rules/rule.proposal.service.js';
import { RulesService } from '#modules/rules/rules.service.js';
import { Rule, RuleProposal, RuleRevision, RuleRevisionsQuery } from '../../../generated/rules.js';

/** The request's scoped container, which a tool resolving per call reads its service and policies from. */
function requireMcpContainer(context: McpToolContext): Container {
    if (!context.container) {
        throw new Error(`MCP tool '${context.toolName}' needs the request container: pass \`container: ctx.container\` to createMcpRequestContext.`);
    }
    return context.container;
}

const ListRulesArgs = z.object({});
const ListRuleProposalsArgs = z.object({});
const ListRuleRevisionsArgs = z.object({ query: RuleRevisionsQuery.optional() });

/**
 * from [rules.ck](../../../../data/contracts/rules.ck) `GET /api/rules`
 */
@Injectable()
export class ListRulesMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'list_rules',
        inputSchema: z.toJSONSchema(ListRulesArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(z.object({ items: z.array(Rule) }), { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: { 'contractkit/security': { policy: 'wilson.view' } },
    };

    async handle(_args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        await requireMcpPolicy(context, container.get(PolicyService), { policy: 'wilson.view' });
        const result = await container.get(RulesService).list();
        const resultJson = JSON.stringify({ items: result });
        return { content: [{ type: 'text', text: resultJson }], structuredContent: JSON.parse(resultJson) };
    }
}

/**
 * from [rules.ck](../../../../data/contracts/rules.ck) `GET /api/rules/proposals`
 */
@Injectable()
export class ListRuleProposalsMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'list_rule_proposals',
        inputSchema: z.toJSONSchema(ListRuleProposalsArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(z.object({ items: z.array(RuleProposal) }), { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: { 'contractkit/security': { policy: 'wilson.view' } },
    };

    async handle(_args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        await requireMcpPolicy(context, container.get(PolicyService), { policy: 'wilson.view' });
        const result = await container.get(RuleProposalService).list();
        const resultJson = JSON.stringify({ items: result });
        return { content: [{ type: 'text', text: resultJson }], structuredContent: JSON.parse(resultJson) };
    }
}

/**
 * from [rules.ck](../../../../data/contracts/rules.ck) `GET /api/rules/revisions`
 */
@Injectable()
export class ListRuleRevisionsMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'list_rule_revisions',
        inputSchema: z.toJSONSchema(ListRuleRevisionsArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(z.object({ items: z.array(RuleRevision) }), { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: { 'contractkit/security': { policy: 'wilson.view' } },
    };

    async handle(args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        await requireMcpPolicy(context, container.get(PolicyService), { policy: 'wilson.view' });
        const { query = await parseAndValidate({}, ListRuleRevisionsArgs.shape.query.unwrap()) } = await parseAndValidate(
            args,
            ListRuleRevisionsArgs,
        );
        const result = await container.get(RulesService).revisions(query);
        const resultJson = JSON.stringify({ items: result });
        return { content: [{ type: 'text', text: resultJson }], structuredContent: JSON.parse(resultJson) };
    }
}

/** Add a handler for each of this file's operations to the catalog, unlisted in `tools/list`. */
export function registerRulesMcpCatalog(map: McpToolHandlerMap, container: Container): void {
    map.set('list_rules', container.get(ListRulesMcpTool));
    map.set('list_rule_proposals', container.get(ListRuleProposalsMcpTool));
    map.set('list_rule_revisions', container.get(ListRuleRevisionsMcpTool));
}

/** Register this file's tool classes on the registry, so the tool maps can resolve them. */
export function registerRulesMcpToolClasses(registry: Registry): void {
    registry.register(ListRulesMcpTool).useClass(ListRulesMcpTool).asSingleton();
    registry.register(ListRuleProposalsMcpTool).useClass(ListRuleProposalsMcpTool).asSingleton();
    registry.register(ListRuleRevisionsMcpTool).useClass(ListRuleRevisionsMcpTool).asSingleton();
}
