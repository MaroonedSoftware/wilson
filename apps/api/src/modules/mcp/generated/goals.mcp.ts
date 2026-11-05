// Auto-generated MCP tools
// generated from [goals.ck](../../../../data/contracts/goals.ck)
import { Injectable, type Container, type Registry } from 'injectkit';
import { z } from 'zod';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { requireMcpPolicy, type McpToolHandler, type McpToolHandlerMap, type McpToolContext } from '@maroonedsoftware/mcp';
import { PolicyService } from '@maroonedsoftware/policies';
import { parseAndValidate } from '@maroonedsoftware/zod';
import { GoalService } from '#modules/goal/goal.service.js';
import { CreateGoalRequest, Goal, GoalDetail, ListGoalsQuery, UpdateGoalRequest } from '../../../generated/goals.js';

/** The request's scoped container, which a tool resolving per call reads its service and policies from. */
function requireMcpContainer(context: McpToolContext): Container {
    if (!context.container) {
        throw new Error(`MCP tool '${context.toolName}' needs the request container: pass \`container: ctx.container\` to createMcpRequestContext.`);
    }
    return context.container;
}

const ListGoalsArgs = z.object({ query: ListGoalsQuery.optional() });
const CreateAGoalArgs = z.object({ body: CreateGoalRequest });
const GetAGoalArgs = z.object({ id: z.string() });
const UpdateAGoalArgs = z.object({ id: z.string(), body: UpdateGoalRequest });
const AddACardToAGoalArgs = z.object({ id: z.string(), cardId: z.string() });
const RemoveACardFromAGoalArgs = z.object({ id: z.string(), cardId: z.string() });

/**
 * from [goals.ck](../../../../data/contracts/goals.ck) `GET /api/goals`
 */
@Injectable()
export class ListGoalsMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'list_goals',
        description: 'The goals a project or thread has, most recently changed first. Filter by project, status or threadId.',
        inputSchema: z.toJSONSchema(ListGoalsArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(z.object({ items: z.array(Goal) }), { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: { 'contractkit/security': { policy: 'wilson.view' } },
    };

    async handle(args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        await requireMcpPolicy(context, container.get(PolicyService), { policy: 'wilson.view' });
        const { query = await parseAndValidate({}, ListGoalsArgs.shape.query.unwrap()) } = await parseAndValidate(args, ListGoalsArgs);
        const result = await container.get(GoalService).list(query);
        const resultJson = JSON.stringify({ items: result });
        return { content: [{ type: 'text', text: resultJson }], structuredContent: JSON.parse(resultJson) };
    }
}

/**
 * from [goals.ck](../../../../data/contracts/goals.ck) `POST /api/goals`
 */
@Injectable()
export class CreateAGoalMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'create_a_goal',
        description: 'Start a goal on a chat thread with no goal yet, for one registered project. `outcome` says what done looks like.',
        inputSchema: z.toJSONSchema(CreateAGoalArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(Goal, { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        _meta: { 'contractkit/security': { policy: 'wilson.manage' } },
    };

    async handle(args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        await requireMcpPolicy(context, container.get(PolicyService), { policy: 'wilson.manage' });
        const { body } = await parseAndValidate(args, CreateAGoalArgs);
        const result = await container.get(GoalService).create(body);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
}

/**
 * from [goals.ck](../../../../data/contracts/goals.ck) `GET /api/goals/{id}`
 */
@Injectable()
export class GetAGoalMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'get_a_goal',
        description: "A goal with its cards, each card's stage, and whether it is flagged for a person.",
        inputSchema: z.toJSONSchema(GetAGoalArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(GoalDetail, { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: { 'contractkit/security': { policy: 'wilson.view' } },
    };

    async handle(args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        await requireMcpPolicy(context, container.get(PolicyService), { policy: 'wilson.view' });
        const { id } = await parseAndValidate(args, GetAGoalArgs);
        const result = await container.get(GoalService).get(id);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
}

/**
 * from [goals.ck](../../../../data/contracts/goals.ck) `PATCH /api/goals/{id}`
 */
@Injectable()
export class UpdateAGoalMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'update_a_goal',
        description: "Change a goal's title, outcome or status. Anything left out stays as it is.",
        inputSchema: z.toJSONSchema(UpdateAGoalArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(Goal, { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        _meta: { 'contractkit/security': { policy: 'wilson.manage' } },
    };

    async handle(args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        await requireMcpPolicy(context, container.get(PolicyService), { policy: 'wilson.manage' });
        const { id, body } = await parseAndValidate(args, UpdateAGoalArgs);
        const result = await container.get(GoalService).update(id, body);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
}

/**
 * from [goals.ck](../../../../data/contracts/goals.ck) `PUT /api/goals/{id}/cards/{cardId}`
 */
@Injectable()
export class AddACardToAGoalMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'add_a_card_to_a_goal',
        description:
            "Linking a card the goal already holds changes nothing. A card is in at most one goal, so one that\nanother goal holds is refused rather than moved.\nPut a card from the goal's own project in the goal. Refused when another goal holds it.",
        inputSchema: z.toJSONSchema(AddACardToAGoalArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(GoalDetail, { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: { 'contractkit/security': { policy: 'wilson.manage' } },
    };

    async handle(args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        await requireMcpPolicy(context, container.get(PolicyService), { policy: 'wilson.manage' });
        const { id, cardId } = await parseAndValidate(args, AddACardToAGoalArgs);
        const result = await container.get(GoalService).addCard(id, cardId);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
}

/**
 * from [goals.ck](../../../../data/contracts/goals.ck) `DELETE /api/goals/{id}/cards/{cardId}`
 */
@Injectable()
export class RemoveACardFromAGoalMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'remove_a_card_from_a_goal',
        description: 'Take a card out of the goal. The card itself is untouched.',
        inputSchema: z.toJSONSchema(RemoveACardFromAGoalArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(GoalDetail, { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        _meta: { 'contractkit/security': { policy: 'wilson.manage' } },
    };

    async handle(args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        await requireMcpPolicy(context, container.get(PolicyService), { policy: 'wilson.manage' });
        const { id, cardId } = await parseAndValidate(args, RemoveACardFromAGoalArgs);
        const result = await container.get(GoalService).removeCard(id, cardId);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
}

/** Add a handler for each of this file's operations to the catalog, unlisted in `tools/list`. */
export function registerGoalsMcpCatalog(map: McpToolHandlerMap, container: Container): void {
    map.set('list_goals', container.get(ListGoalsMcpTool));
    map.set('create_a_goal', container.get(CreateAGoalMcpTool));
    map.set('get_a_goal', container.get(GetAGoalMcpTool));
    map.set('update_a_goal', container.get(UpdateAGoalMcpTool));
    map.set('add_a_card_to_a_goal', container.get(AddACardToAGoalMcpTool));
    map.set('remove_a_card_from_a_goal', container.get(RemoveACardFromAGoalMcpTool));
}

/** Register this file's tool classes on the registry, so the tool maps can resolve them. */
export function registerGoalsMcpToolClasses(registry: Registry): void {
    registry.register(ListGoalsMcpTool).useClass(ListGoalsMcpTool).asSingleton();
    registry.register(CreateAGoalMcpTool).useClass(CreateAGoalMcpTool).asSingleton();
    registry.register(GetAGoalMcpTool).useClass(GetAGoalMcpTool).asSingleton();
    registry.register(UpdateAGoalMcpTool).useClass(UpdateAGoalMcpTool).asSingleton();
    registry.register(AddACardToAGoalMcpTool).useClass(AddACardToAGoalMcpTool).asSingleton();
    registry.register(RemoveACardFromAGoalMcpTool).useClass(RemoveACardFromAGoalMcpTool).asSingleton();
}
