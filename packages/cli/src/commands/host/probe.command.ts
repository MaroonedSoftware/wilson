import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';
import { describeHost } from '../../host-view.js';

/**
 * Connect to a host and record what is there (`POST /api/hosts/{name}/probe`): whether SSH reaches
 * it, its `claude` version, whether each project's clone is a git repository, and when it expires.
 * Exits 1 when the probe failed, so a script can wait for a fresh VM with `until wilson host probe`.
 */
const command: CommandModule = {
    description: 'Check a host is reachable and ready, and record what was found',
    args: [{ name: 'name', description: 'The host name', required: true }],
    run: withApi(async (_opts, ctx, args, api) => {
        const host = await api.hosts.probeHost(String(args[0]));
        for (const line of describeHost(host)) ctx.logger.info(line);
        return host.probe?.ok ? 0 : 1;
    }),
};

export default command;
