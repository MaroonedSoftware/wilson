import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';
import { withStepUp } from '../../sign.in.js';

interface RmOpts {
    message?: string;
}

/** Remove a checked rule. Its history stays. The save asks for the password (`withStepUp`). */
const command: CommandModule<RmOpts> = {
    description: 'Remove a checked rule',
    args: [{ name: 'id', description: 'The rule to remove', required: true }],
    options: [{ flags: '-m, --message <text>', description: 'What this change is, for the history', type: 'string' }],
    run: withApi<RmOpts>(async (opts, ctx, args, api) => {
        const id = String(args[0]);
        await withStepUp(ctx, api, client => client.rules.deleteRule(id, opts.message ? { message: opts.message } : {}));
        ctx.logger.info(`${id}: removed`);
        return 0;
    }),
};

export default command;
