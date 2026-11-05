import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';

/** Print what an eval run left in its tree (`GET /api/evals/runs/{id}/patch`), to stdout so it can be piped. */
const command: CommandModule = {
    description: 'Print the work an eval run did',
    args: [{ name: 'run', description: 'The run id', required: true }],
    run: withApi(async (_opts, ctx, args, api) => {
        const { patch, truncated } = await api.evals.getEvalRunPatch(String(args[0]));
        process.stdout.write(patch);
        if (truncated) ctx.logger.warn('this patch was cut at 256 KB');
        return 0;
    }),
};

export default command;
