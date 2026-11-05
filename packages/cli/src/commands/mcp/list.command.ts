import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';
import { connectionLine } from './print.js';

const command: CommandModule = {
    description: 'List the MCP servers Wilson connects to',
    run: withApi(async (_opts, ctx, _args, api) => {
        const connections = await api.mcpConnections.listMCPConnections();
        if (connections.length === 0) ctx.logger.info('no MCP connections yet: `wilson mcp add <name> <url>` adds one');
        for (const connection of connections) ctx.logger.info(connectionLine(connection));
        return 0;
    }),
};

export default command;
