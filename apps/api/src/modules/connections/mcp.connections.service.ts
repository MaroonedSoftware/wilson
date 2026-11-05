import { Injectable } from 'injectkit';
import { httpError } from '@maroonedsoftware/errors';
import { Logger } from '@maroonedsoftware/logger';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ProjectRepository } from '#modules/board/project.repository.js';
import { SecretsService } from '#modules/secrets/secrets.service.js';
import type { McpConnection, PutMcpConnectionRequest, ReviewMcpToolsRequest } from '../../generated/mcp.connections.js';
import { McpSession, type ListedTool } from './mcp.client.js';
import { isUsable, McpConnectionRepository, type McpConnectionRow, type McpToolRow } from './mcp.connection.repository.js';

/** No dots, since an external operation is `<connection>.<tool>` and a tool's own name may hold one. */
const CONNECTION_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** An outside tool as a caller is offered it, named as an operation. */
export interface ExternalTool {
    name: string;
    description: string;
    /** True for a tool a person marked as a read. Never taken from the server. */
    readOnly: boolean;
    inputSchema: unknown;
}

/** The operation name of a connection's tool. */
const operationName = (connection: string, tool: string): string => `${connection}.${tool}`;

/** Whether `name` is an external operation rather than one of Wilson's own, none of which holds a dot. */
export const isExternalOperation = (name: string): boolean => name.includes('.');

const refused = (reason: string) => httpError(400).withDetails({ reason });

/** A failure on the server's side of a call, as opposed to one Wilson refused. */
const failed = (reason: string) => httpError(502).withDetails({ reason });

/** What a tool answered, as data: its structured result, or its text, parsed when it is JSON. */
const resultValue = (result: CallToolResult): unknown => {
    if (result.structuredContent !== undefined) return result.structuredContent;
    const parts = result.content.map(part => (part.type === 'text' ? part.text : `[${part.type} omitted]`));
    const text = parts.join('\n');
    if (parts.length !== 1) return text;
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
};

/** `value` with `redact` applied to every string in it, keys included. */
const redactDeep = (value: unknown, redact: (text: string) => string): unknown => {
    if (typeof value === 'string') return redact(value);
    if (Array.isArray(value)) return value.map(part => redactDeep(part, redact));
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, part]) => [redact(key), redactDeep(part, redact)]));
    }
    return value;
};

/**
 * Outside MCP servers, behind `/api/mcp-connections` (`mcp.connections.ck`). Wilson is the only client,
 * so a server's credential never leaves this service.
 *
 * What a model is told about a tool is always the stored text a person reviewed, never what a server
 * says now. Each {@link call} lists the tools again before running one, so a tool whose description
 * changed is refused and waits for another review. That cannot catch a server that changes what a tool
 * does and keeps its description.
 */
@Injectable()
export class McpConnectionsService {
    constructor(
        private readonly connections: McpConnectionRepository,
        private readonly secrets: SecretsService,
        private readonly projects: ProjectRepository,
        private readonly logger: Logger,
    ) {}

    async list(): Promise<McpConnection[]> {
        const [connections, tools] = await Promise.all([this.connections.list(), this.connections.tools()]);
        return connections.map(connection =>
            toConnection(
                connection,
                tools.filter(tool => tool.connection === connection.name),
            ),
        );
    }

    /** Connect, list, and save only if that worked. Refuses a bad name or address, an unknown secret or project, or a server it could not list. */
    async put(name: string, { url, secret, project }: PutMcpConnectionRequest): Promise<McpConnection> {
        if (!CONNECTION_NAME.test(name)) {
            throw refused('a connection name is lowercase letters, digits, dashes and underscores');
        }
        checkUrl(url);
        const bearer = secret === undefined ? undefined : await this.secrets.resolve(secret);
        if (secret !== undefined && bearer === undefined) throw refused(`no secret is saved as "${secret}"`);
        if (project !== undefined && !(await this.projects.find(project))) throw refused(`project "${project}" is not registered`);

        await this.connections.put(name, { url, secret, project }, await this.listFrom(url, bearer));
        return this.one(name);
    }

    async remove(name: string): Promise<void> {
        if (!(await this.connections.remove(name))) throw notFound(name);
    }

    /** List the server's tools again. Anything it now describes differently stops being usable until it is reviewed. */
    async refresh(name: string): Promise<McpConnection> {
        const connection = await this.connections.find(name);
        if (!connection) throw notFound(name);
        await this.connections.refresh(name, await this.listFrom(connection.url, await this.bearerOf(connection)));
        return this.one(name);
    }

    /** Decide how each named tool may be used, approving what it is listed as now. Refuses a tool the server does not list, changing nothing. */
    async review(name: string, { tools }: ReviewMcpToolsRequest): Promise<McpConnection> {
        if (!(await this.connections.find(name))) throw notFound(name);
        const known = new Set((await this.connections.tools(name)).map(tool => tool.name));
        const unknown = tools.filter(tool => !known.has(tool.name)).map(tool => tool.name);
        if (unknown.length > 0) throw refused(`"${name}" does not list: ${unknown.join(', ')}`);
        await this.connections.review(name, tools);
        return this.one(name);
    }

    /** Every outside tool a person has reviewed and allowed, with the text they reviewed. */
    async usableTools(): Promise<ExternalTool[]> {
        const tools = await this.connections.tools();
        return tools.filter(isUsable).map(tool => ({
            name: operationName(tool.connection, tool.name),
            description: tool.description,
            readOnly: tool.access === 'read',
            inputSchema: tool.inputSchema,
        }));
    }

    /** Whether `operation` is a tool marked as a read. Undefined for one that does not exist. */
    async isRead(operation: string): Promise<boolean | undefined> {
        const { connection, tool } = parseOperation(operation);
        const row = (await this.connections.tools(connection)).find(candidate => candidate.name === tool);
        return row && row.access === 'read';
    }

    /**
     * Run an outside tool and answer with its result, with every saved secret's value taken out. Refuses
     * a tool that is unknown, disabled or unreviewed, one used outside the project its connection is for,
     * and, with `mustBeRead`, one no longer marked as a read. Lists first, and refuses a tool whose
     * listing changed, recording the change. A 502 is the server's failure.
     */
    async call(
        operation: string,
        args: Record<string, unknown>,
        { project, mustBeRead = false }: { project?: string; mustBeRead?: boolean },
    ): Promise<unknown> {
        const { connection: name, tool: toolName } = parseOperation(operation);
        const connection = await this.connections.find(name);
        const tool = connection && (await this.connections.tools(name)).find(candidate => candidate.name === toolName);
        if (!connection || !tool) throw refused(`there is no operation named "${operation}"`);
        if (!isUsable(tool)) throw refused(`"${operation}" has not been allowed: review it with \`wilson mcp review ${name}\``);
        if (mustBeRead && tool.access !== 'read') throw refused(`"${operation}" is no longer marked as a read, so it is not run directly`);
        if (connection.project !== undefined && connection.project !== project) {
            throw refused(`"${operation}" can only be used in project "${connection.project}"`);
        }

        const redact = await this.secrets.redactor();
        let session: McpSession | undefined;
        try {
            session = await McpSession.open(connection.url, await this.bearerOf(connection));
            const listed = await session.list();
            if (listed.find(candidate => candidate.name === toolName)?.fingerprint !== tool.fingerprint) {
                await this.connections.refresh(name, listed);
                this.logger.warn(`mcp ${operation}: the server's listing changed, so the tool waits for another review`);
                throw refused(`the server now describes "${operation}" differently, so it waits for another review`);
            }
            const result = await session.call(toolName, args);
            const value = redactDeep(resultValue(result), redact);
            if (result.isError) throw failed(typeof value === 'string' ? value : JSON.stringify(value));
            this.logger.info(`mcp ${operation}: ran`);
            return value;
        } catch (err) {
            if ((err as { details?: unknown }).details !== undefined) throw err;
            const reason = redact(err instanceof Error ? err.message : String(err));
            this.logger.warn(`mcp ${operation}: failed: ${reason}`);
            throw failed(reason);
        } finally {
            await session?.close().catch(() => undefined);
        }
    }

    private async one(name: string): Promise<McpConnection> {
        const connection = await this.connections.find(name);
        if (!connection) throw notFound(name);
        return toConnection(connection, await this.connections.tools(name));
    }

    private async bearerOf(connection: McpConnectionRow): Promise<string | undefined> {
        return connection.secret === undefined ? undefined : this.secrets.resolve(connection.secret);
    }

    private async listFrom(url: string, bearer?: string): Promise<ListedTool[]> {
        let session: McpSession | undefined;
        try {
            session = await McpSession.open(url, bearer);
            return await session.list();
        } catch (err) {
            const redact = await this.secrets.redactor();
            throw refused(`could not list the tools at ${url}: ${redact(err instanceof Error ? err.message : String(err))}`);
        } finally {
            await session?.close().catch(() => undefined);
        }
    }
}

const notFound = (name: string) => httpError(404).withDetails({ reason: `no MCP connection is saved as "${name}"` });

/** Splits on the first dot, since a tool's own name may hold one and a connection's cannot. */
const parseOperation = (operation: string): { connection: string; tool: string } => {
    const dot = operation.indexOf('.');
    return { connection: operation.slice(0, dot), tool: operation.slice(dot + 1) };
};

/** An http or https address with no credentials in it, which would end up in the list this service answers. */
const checkUrl = (url: string): void => {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw refused(`"${url}" is not an address`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw refused('a connection address is http or https');
    if (parsed.username !== '' || parsed.password !== '')
        throw refused('a connection address cannot hold credentials: save them with `wilson secret set`');
};

const toConnection = (connection: McpConnectionRow, tools: readonly McpToolRow[]): McpConnection => ({
    name: connection.name,
    url: connection.url,
    ...(connection.secret !== undefined && { secret: connection.secret }),
    ...(connection.project !== undefined && { project: connection.project }),
    tools: tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as McpConnection['tools'][number]['inputSchema'],
        readOnlyHint: tool.readOnlyHint,
        access: tool.access,
        needsReview: tool.approvedFingerprint !== tool.fingerprint,
    })),
    refreshedAt: connection.refreshedAt,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
});
