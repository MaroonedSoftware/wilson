import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';

interface UpdateOpts {
    priority?: number;
    pool?: boolean;
    leavePool?: boolean;
}

/** Change a saved token's priority or whether it is in the pool (`PATCH /api/engine-tokens/{name}`), keeping the token. */
const command: CommandModule = {
    description: "Change a saved engine token's priority or pool membership, keeping the token",
    args: [{ name: 'name', description: 'The name it is saved under', required: true }],
    options: [
        { flags: '--priority <n>', description: "Which of a provider's tokens comes first, lowest first, 0 to 1000", type: 'number' },
        { flags: '--pool', description: 'Let Wilson choose this token for an engine with no token assigned', type: 'boolean' },
        { flags: '--leave-pool', description: 'Stop Wilson choosing this token', type: 'boolean' },
    ],
    run: withApi<UpdateOpts>(async (opts, ctx, args, api) => {
        const name = String(args[0]);
        if (opts.pool && opts.leavePool) {
            ctx.logger.error('choose one of --pool and --leave-pool');
            return 1;
        }
        const saved = await api.engineTokens.updateEngineToken(name, {
            ...(opts.priority !== undefined && { priority: opts.priority }),
            ...(opts.pool && { pooled: true }),
            ...(opts.leavePool && { pooled: false }),
        });
        ctx.logger.info(`${name}: priority ${saved.priority}, ${saved.pooled ? 'pooled' : 'not pooled'}`);
        return 0;
    }),
};

export default command;
