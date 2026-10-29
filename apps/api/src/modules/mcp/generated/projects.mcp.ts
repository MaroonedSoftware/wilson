// Auto-generated MCP tools
// generated from [projects.ck](../../../../data/contracts/projects.ck)
import { Injectable, type Container, type Registry } from 'injectkit';
import { z } from 'zod';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { requireMcpPolicy, type McpToolHandler, type McpToolHandlerMap, type McpToolContext } from '@maroonedsoftware/mcp';
import { PolicyService } from '@maroonedsoftware/policies';
import { parseAndValidate } from '@maroonedsoftware/zod';
import { ProjectDirectoriesService } from '#modules/board/project.directories.service.js';
import { ProjectsService } from '#modules/board/projects.service.js';
import { CreateProjectRequest, DirectoryListing, DirectoryQuery, Project, UpdateProjectRequest } from '../../../generated/projects.js';

/** The request's scoped container, which a tool resolving per call reads its service and policies from. */
function requireMcpContainer(context: McpToolContext): Container {
    if (!context.container) {
        throw new Error(`MCP tool '${context.toolName}' needs the request container: pass \`container: ctx.container\` to createMcpRequestContext.`);
    }
    return context.container;
}

const ListProjectsArgs = z.object({});
const RegisterProjectArgs = z.object({ body: CreateProjectRequest });
const UpdateProjectPathsArgs = z.object({ name: z.string(), body: UpdateProjectRequest });
const ListDirectoriesArgs = z.object({ query: DirectoryQuery.optional() });

/**
 * from [projects.ck](../../../../data/contracts/projects.ck) `GET /api/projects`
 */
@Injectable()
export class ListProjectsMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'list_projects',
        description:
            "No project header or `?project=` is required, and none is refused: `ProjectContextRouter`\n(routes.setup.ts) only refuses a project that is *named and unregistered* — with neither set, it\nfalls back to the daemon's own configured project and calls `next`, the same as every other route\non this surface. That catch-all is already correct for a route that lists every project, so no\nexemption was added for it.",
        inputSchema: z.toJSONSchema(ListProjectsArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(z.object({ items: z.array(Project) }), { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: { 'contractkit/security': { policy: 'wilson.view' } },
    };

    async handle(_args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        await requireMcpPolicy(context, container.get(PolicyService), { policy: 'wilson.view' });
        const result = await container.get(ProjectsService).list();
        const resultJson = JSON.stringify({ items: result });
        return { content: [{ type: 'text', text: resultJson }], structuredContent: JSON.parse(resultJson) };
    }
}

/**
 * from [projects.ck](../../../../data/contracts/projects.ck) `POST /api/projects`
 */
@Injectable()
export class RegisterProjectMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'register_project',
        description:
            'Card 0168. Returns `Project` — the name alone, not the four paths just sent — the same\nresponse shape `get` above answers with. Card 0162 withheld those four paths from an\nunauthenticated read surface on purpose; echoing them back from a write would reverse that\nquietly, for a caller that already has them. `ProjectsService.create` is where the path\nvalidation and the duplicate-name refusal live.',
        inputSchema: z.toJSONSchema(RegisterProjectArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(Project, { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        _meta: { 'contractkit/security': { policy: 'wilson.manage' } },
    };

    async handle(args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        await requireMcpPolicy(context, container.get(PolicyService), { policy: 'wilson.manage' });
        const { body } = await parseAndValidate(args, RegisterProjectArgs);
        const result = await container.get(ProjectsService).create(body);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
}

/**
 * from [projects.ck](../../../../data/contracts/projects.ck) `PATCH /api/projects/{name}`
 */
@Injectable()
export class UpdateProjectPathsMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'update_project_paths',
        description:
            "Not `put`. Fields present in the body are set; fields absent are left as they are — see\n`UpdateProjectRequest`'s own comment, and `board.ck`'s `PATCH /api/cards/{id}` for the same\nreasoning stated once and not repeated differently here.",
        inputSchema: z.toJSONSchema(UpdateProjectPathsArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(Project, { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        _meta: { 'contractkit/security': { policy: 'wilson.manage' } },
    };

    async handle(args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        await requireMcpPolicy(context, container.get(PolicyService), { policy: 'wilson.manage' });
        const { name, body } = await parseAndValidate(args, UpdateProjectPathsArgs);
        const result = await container.get(ProjectsService).update(name, body);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
}

/**
 * from [projects.ck](../../../../data/contracts/projects.ck) `GET /api/projects/directories`
 */
@Injectable()
export class ListDirectoriesMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'list_directories',
        description:
            "Lists folders on the daemon's machine, confined to the daemon user's home folder: a path outside\nit (after resolving symlinks) is refused rather than listed. A disclosure weighed the way\n`CreateProjectRequest`'s comment weighs accepting paths: only an authenticated caller reaches it,\nand the operator can already read the disk as this user.\nThe home-folder confinement is what keeps the listing to the part of the disk a project lives in.\nPath segment, not a project: `/api/projects/{name}` has no `get`, so there is no clash.",
        inputSchema: z.toJSONSchema(ListDirectoriesArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(DirectoryListing, { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: { 'contractkit/security': { policy: 'wilson.view' } },
    };

    async handle(args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        await requireMcpPolicy(context, container.get(PolicyService), { policy: 'wilson.view' });
        const { query = await parseAndValidate({}, ListDirectoriesArgs.shape.query.unwrap()) } = await parseAndValidate(args, ListDirectoriesArgs);
        const result = await container.get(ProjectDirectoriesService).list(query);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
}

/** Add a handler for each of this file's operations to the catalog, unlisted in `tools/list`. */
export function registerProjectsMcpCatalog(map: McpToolHandlerMap, container: Container): void {
    map.set('list_projects', container.get(ListProjectsMcpTool));
    map.set('register_project', container.get(RegisterProjectMcpTool));
    map.set('update_project_paths', container.get(UpdateProjectPathsMcpTool));
    map.set('list_directories', container.get(ListDirectoriesMcpTool));
}

/** Register this file's tool classes on the registry, so the tool maps can resolve them. */
export function registerProjectsMcpToolClasses(registry: Registry): void {
    registry.register(ListProjectsMcpTool).useClass(ListProjectsMcpTool).asSingleton();
    registry.register(RegisterProjectMcpTool).useClass(RegisterProjectMcpTool).asSingleton();
    registry.register(UpdateProjectPathsMcpTool).useClass(UpdateProjectPathsMcpTool).asSingleton();
    registry.register(ListDirectoriesMcpTool).useClass(ListDirectoriesMcpTool).asSingleton();
}
