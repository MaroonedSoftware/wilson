// Auto-generated MCP tools
// generated from [hosts.ck](../../../../data/contracts/hosts.ck)
import { Injectable, type Container, type Registry } from 'injectkit';
import { z } from 'zod';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { McpToolHandler, McpToolHandlerMap, McpToolContext } from '@maroonedsoftware/mcp';
import { parseAndValidate } from '@maroonedsoftware/zod';
import { HostProber } from '#modules/host/host.prober.js';
import { HostsService } from '#modules/host/hosts.service.js';
import { CreateHostRequest, Host, PutHostProjectRequest, UpdateHostRequest } from '../../../generated/hosts.js';

/** The request's scoped container, which a tool resolving per call reads its service and policies from. */
function requireMcpContainer(context: McpToolContext): Container {
    if (!context.container) {
        throw new Error(`MCP tool '${context.toolName}' needs the request container: pass \`container: ctx.container\` to createMcpRequestContext.`);
    }
    return context.container;
}

const ListHostsArgs = z.object({});
const RegisterHostArgs = z.object({ body: CreateHostRequest });
const GetHostArgs = z.object({ name: z.string() });
const UpdateHostArgs = z.object({ name: z.string(), body: UpdateHostRequest });
const RemoveHostArgs = z.object({ name: z.string() });
const ProbeHostArgs = z.object({ name: z.string() });
const SetHostProjectArgs = z.object({ name: z.string(), project: z.string(), body: PutHostProjectRequest });
const RemoveHostProjectArgs = z.object({ name: z.string(), project: z.string() });

/**
 * from [hosts.ck](../../../../data/contracts/hosts.ck) `GET /api/hosts`
 */
@Injectable()
export class ListHostsMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'list_hosts',
        inputSchema: z.toJSONSchema(ListHostsArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(z.object({ items: z.array(Host) }), { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: { 'contractkit/security': 'none' },
    };

    async handle(_args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        const result = await container.get(HostsService).list();
        const resultJson = JSON.stringify({ items: result });
        return { content: [{ type: 'text', text: resultJson }], structuredContent: JSON.parse(resultJson) };
    }
}

/**
 * from [hosts.ck](../../../../data/contracts/hosts.ck) `POST /api/hosts`
 */
@Injectable()
export class RegisterHostMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'register_host',
        inputSchema: z.toJSONSchema(RegisterHostArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(Host, { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        _meta: { 'contractkit/security': 'none' },
    };

    async handle(args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        const { body } = await parseAndValidate(args, RegisterHostArgs);
        const result = await container.get(HostsService).create(body);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
}

/**
 * from [hosts.ck](../../../../data/contracts/hosts.ck) `GET /api/hosts/{name}`
 */
@Injectable()
export class GetHostMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'get_host',
        inputSchema: z.toJSONSchema(GetHostArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(Host, { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: { 'contractkit/security': 'none' },
    };

    async handle(args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        const { name } = await parseAndValidate(args, GetHostArgs);
        const result = await container.get(HostsService).get(name);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
}

/**
 * from [hosts.ck](../../../../data/contracts/hosts.ck) `PATCH /api/hosts/{name}`
 */
@Injectable()
export class UpdateHostMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'update_host',
        inputSchema: z.toJSONSchema(UpdateHostArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(Host, { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        _meta: { 'contractkit/security': 'none' },
    };

    async handle(args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        const { name, body } = await parseAndValidate(args, UpdateHostArgs);
        const result = await container.get(HostsService).update(name, body);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
}

/**
 * from [hosts.ck](../../../../data/contracts/hosts.ck) `DELETE /api/hosts/{name}`
 */
@Injectable()
export class RemoveHostMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'remove_host',
        inputSchema: z.toJSONSchema(RemoveHostArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        _meta: { 'contractkit/security': 'none' },
    };

    async handle(args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        const { name } = await parseAndValidate(args, RemoveHostArgs);
        await container.get(HostsService).remove(name);
        return { content: [{ type: 'text', text: 'OK' }] };
    }
}

/**
 * from [hosts.ck](../../../../data/contracts/hosts.ck) `POST /api/hosts/{name}/probe`
 */
@Injectable()
export class ProbeHostMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'probe_host',
        description:
            "Connect to the host and record what is there: that SSH reaches it, which `claude` it has, that each\nproject's clone is a git repository and its roots can be written, and, given a lifetime, when it\nwill stop. A failed check is a recorded result (`probe.ok: false`), not an error response.",
        inputSchema: z.toJSONSchema(ProbeHostArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(Host, { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        _meta: { 'contractkit/security': 'none' },
    };

    async handle(args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        const { name } = await parseAndValidate(args, ProbeHostArgs);
        const result = await container.get(HostProber).probe(name);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
}

/**
 * from [hosts.ck](../../../../data/contracts/hosts.ck) `PUT /api/hosts/{name}/projects/{project}`
 */
@Injectable()
export class SetHostProjectMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'set_host_project',
        description:
            '`put`, not `patch`: a project on a host is its three paths together, and a half-set one would\ncut worktrees from a clone that is not there.',
        inputSchema: z.toJSONSchema(SetHostProjectArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(Host, { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: { 'contractkit/security': 'none' },
    };

    async handle(args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        const { name, project, body } = await parseAndValidate(args, SetHostProjectArgs);
        const result = await container.get(HostsService).putProject(name, project, body);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
}

/**
 * from [hosts.ck](../../../../data/contracts/hosts.ck) `DELETE /api/hosts/{name}/projects/{project}`
 */
@Injectable()
export class RemoveHostProjectMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'remove_host_project',
        description:
            '`put`, not `patch`: a project on a host is its three paths together, and a half-set one would\ncut worktrees from a clone that is not there.',
        inputSchema: z.toJSONSchema(RemoveHostProjectArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        _meta: { 'contractkit/security': 'none' },
    };

    async handle(args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        const { name, project } = await parseAndValidate(args, RemoveHostProjectArgs);
        await container.get(HostsService).removeProject(name, project);
        return { content: [{ type: 'text', text: 'OK' }] };
    }
}

/** Add a handler for each of this file's operations to the catalog, unlisted in `tools/list`. */
export function registerHostsMcpCatalog(map: McpToolHandlerMap, container: Container): void {
    map.set('list_hosts', container.get(ListHostsMcpTool));
    map.set('register_host', container.get(RegisterHostMcpTool));
    map.set('get_host', container.get(GetHostMcpTool));
    map.set('update_host', container.get(UpdateHostMcpTool));
    map.set('remove_host', container.get(RemoveHostMcpTool));
    map.set('probe_host', container.get(ProbeHostMcpTool));
    map.set('set_host_project', container.get(SetHostProjectMcpTool));
    map.set('remove_host_project', container.get(RemoveHostProjectMcpTool));
}

/** Register this file's tool classes on the registry, so the tool maps can resolve them. */
export function registerHostsMcpToolClasses(registry: Registry): void {
    registry.register(ListHostsMcpTool).useClass(ListHostsMcpTool).asSingleton();
    registry.register(RegisterHostMcpTool).useClass(RegisterHostMcpTool).asSingleton();
    registry.register(GetHostMcpTool).useClass(GetHostMcpTool).asSingleton();
    registry.register(UpdateHostMcpTool).useClass(UpdateHostMcpTool).asSingleton();
    registry.register(RemoveHostMcpTool).useClass(RemoveHostMcpTool).asSingleton();
    registry.register(ProbeHostMcpTool).useClass(ProbeHostMcpTool).asSingleton();
    registry.register(SetHostProjectMcpTool).useClass(SetHostProjectMcpTool).asSingleton();
    registry.register(RemoveHostProjectMcpTool).useClass(RemoveHostProjectMcpTool).asSingleton();
}
