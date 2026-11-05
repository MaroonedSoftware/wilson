import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';
import { connectionLine } from './print.js';

const command: CommandModule = {
    description: "List an MCP server's tools again. Any it now describes differently stop being usable until reviewed",
    args: [{ name: 'name', description: 'The connection', required: true }],
    run: withApi(async (_opts, ctx, args, api) => {
        ctx.logger.info(connectionLine(await api.mcpConnections.refreshMCPConnection(String(args[0]))));
        return 0;
    }),
};

export default command;
