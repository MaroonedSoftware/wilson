import { Registry } from 'injectkit';
import { AppConfig } from '@maroonedsoftware/appconfig';
import { ServerKitModule } from '@maroonedsoftware/koa';
import { McpConnectionRepository } from './mcp.connection.repository.js';
import { McpConnectionsService } from './mcp.connections.service.js';

/** Outside MCP servers, where Wilson is the client (`mcp.connections.ck`). `McpModule` is the other direction: Wilson's own operations. */
export const ConnectionsModule: ServerKitModule = {
    name: 'Connections',
    setup: async (registry: Registry, _: AppConfig) => {
        registry.register(McpConnectionRepository).useClass(McpConnectionRepository).asTransient();
        registry.register(McpConnectionsService).useClass(McpConnectionsService).asTransient();
    },
};
