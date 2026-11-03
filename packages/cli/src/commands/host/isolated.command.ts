import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';
import { withStepUp } from '../../sign.in.js';

interface IsolatedOpts {
    clear?: boolean;
}

/**
 * Vouch that a host keeps a stage from everything but its own work (`PUT /api/hosts/{name}/isolated`),
 * or with `--clear` take that back. Both ask for the password (`withStepUp`), since this decides which
 * machines may run a stage marked `isolated`, and nothing can test it from outside.
 */
const command: CommandModule<IsolatedOpts> = {
    description: 'Vouch that a host is isolated, so stages marked isolated may run there, or take that back',
    args: [{ name: 'name', description: 'The host name', required: true }],
    options: [{ flags: '--clear', description: 'Stop treating it as isolated', type: 'boolean' }],
    run: withApi<IsolatedOpts>(async (opts, ctx, args, api) => {
        const name = String(args[0]);
        const isolated = !opts.clear;
        await withStepUp(ctx, api, client => client.hosts.setHostIsolated(name, { isolated }));
        ctx.logger.info(isolated ? `${name} may now run stages marked isolated` : `${name} no longer runs stages marked isolated`);
        return 0;
    }),
};

export default command;
