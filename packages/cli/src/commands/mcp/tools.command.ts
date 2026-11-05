import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';
import { toolLines } from './print.js';

const command: CommandModule = {
    description: "Show an MCP connection's tools: how each may be used, what it says it does, and what it takes",
    args: [{ name: 'name', description: 'The connection', required: true }],
    run: withApi(async (_opts, ctx, args, api) => {
        const name = String(args[0]);
        const connection = (await api.mcpConnections.listMCPConnections()).find(candidate => candidate.name === name);
        if (!connection) {
            ctx.logger.error(`no MCP connection is saved as "${name}"`);
            return 1;
        }
        for (const line of toolLines(connection)) ctx.logger.info(line);
        return 0;
    }),
};

export default command;
