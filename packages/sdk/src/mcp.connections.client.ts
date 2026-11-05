import type { McpConnection, PutMcpConnectionRequest, ReviewMcpToolsRequest } from './types/mcp.connections.js';
import { reviveMcpConnection } from './types/mcp.connections.js';
import type { SdkFetch } from './sdk-options.js';
import { bigIntReplacer, parseJson } from './sdk-options.js';

/**
 * generated from [mcp.connections.ck](../../../apps/api/data/contracts/mcp.connections.ck)
 */
export class McpConnectionsClient {
    constructor(private fetch: SdkFetch) {}

    /** @name List MCP connections */
    async listMCPConnections(): Promise<McpConnection[]> {
        const result = await this.fetch(`/api/mcp-connections`, { method: 'GET' });
        return (await parseJson<McpConnection[]>(result)).map(reviveMcpConnection);
    }

    /**
     * @name Put MCP connection
     * @description Connect to a server and list its tools, saving nothing if that fails. Replaces any connection saved
     * under `name`. A new address forgets every review, since it may be another server. No tool is
     * usable until it is reviewed.
     */
    async putMCPConnection(name: string, body: PutMcpConnectionRequest): Promise<McpConnection> {
        const result = await this.fetch(`/api/mcp-connections/${encodeURIComponent(name)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return reviveMcpConnection(await parseJson<McpConnection>(result));
    }

    /** @name Remove MCP connection */
    async removeMCPConnection(name: string): Promise<void> {
        await this.fetch(`/api/mcp-connections/${encodeURIComponent(name)}`, { method: 'DELETE' });
    }

    /**
     * @name Refresh MCP connection
     * @description List the server's tools again. Anything it now describes differently stops being usable until it is
     * reviewed. Lowered to `wilson.manage`, since this can only take authority away.
     */
    async refreshMCPConnection(name: string): Promise<McpConnection> {
        const result = await this.fetch(`/api/mcp-connections/${encodeURIComponent(name)}/refresh`, { method: 'POST' });
        return reviveMcpConnection(await parseJson<McpConnection>(result));
    }

    /**
     * @name Review MCP tools
     * @description Decide how each named tool may be used, approving what it is described as now. Tools left out stay
     * as they are.
     */
    async reviewMCPTools(name: string, body: ReviewMcpToolsRequest): Promise<McpConnection> {
        const result = await this.fetch(`/api/mcp-connections/${encodeURIComponent(name)}/tools`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return reviveMcpConnection(await parseJson<McpConnection>(result));
    }
}
