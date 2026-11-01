import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';

interface EngineTokenOpts {
    clear?: boolean;
}

/**
 * Choose the saved engine token a worker host's engines sign in with (`PUT
 * /api/hosts/{name}/engine-token`), or with `--clear` go back to the worker's own (`DELETE`).
 */
const command: CommandModule<EngineTokenOpts> = {
    description: 'Assign a saved engine token to a worker host, or clear it',
    args: [
        { name: 'host', description: 'The worker host name', required: true },
        { name: 'token', description: 'The saved token’s name; omit it with --clear', required: false },
    ],
    options: [{ flags: '--clear', description: 'Go back to the worker’s own sign-in', type: 'boolean' }],
    run: withApi<EngineTokenOpts>(async (opts, ctx, args, api) => {
        const host = String(args[0]);
        if (opts.clear) {
            await api.hosts.unassignEngineToken(host);
            ctx.logger.info(`${host}'s engines now sign in as that machine was set up to`);
            return 0;
        }
        if (args[1] === undefined) {
            ctx.logger.error('name a saved token, or pass --clear; `wilson engine-token list` shows them');
            return 1;
        }
        await api.hosts.assignEngineToken(host, { name: String(args[1]) });
        ctx.logger.info(`${host}'s next engine signs in with ${String(args[1])}`);
        return 0;
    }),
};

export default command;
