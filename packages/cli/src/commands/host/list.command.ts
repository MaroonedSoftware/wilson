import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';
import { describeHost } from '../../host-view.js';

const command: CommandModule = {
    description: 'List registered hosts, their switches, last probe and the projects they serve',
    run: withApi(async (_opts, ctx, _args, api) => {
        const hosts = await api.hosts.listHosts();
        if (hosts.length === 0) {
            ctx.logger.info('no hosts yet: `wilson host add <name>` registers one');
            return 0;
        }
        for (const host of hosts) {
            for (const line of describeHost(host)) ctx.logger.info(line);
        }
        return 0;
    }),
};

export default command;
