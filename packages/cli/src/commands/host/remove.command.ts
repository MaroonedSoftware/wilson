import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';

/** Unregister a host, and with it every project it served (`DELETE /api/hosts/{name}`). */
const command: CommandModule = {
    description: 'Unregister a host',
    args: [{ name: 'name', description: 'The host name', required: true }],
    run: withApi(async (_opts, ctx, args, api) => {
        const name = String(args[0]);
        await api.hosts.removeHost(name);
        ctx.logger.info(`${name} removed`);
        return 0;
    }),
};

export default command;
