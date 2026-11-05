import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';
import { withStepUp } from '../../sign.in.js';

const command: CommandModule = {
    description: 'Forget an MCP connection. Its secret stays saved',
    args: [{ name: 'name', description: 'The connection', required: true }],
    run: withApi(async (_opts, ctx, args, api) => {
        const name = String(args[0]);
        await withStepUp(ctx, api, client => client.mcpConnections.removeMCPConnection(name));
        ctx.logger.info(`${name} removed.`);
        return 0;
    }),
};

export default command;
