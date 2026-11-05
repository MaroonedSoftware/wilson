import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';

/** Stop a batch (`POST /api/evals/batches/{id}/stop`). A run in progress finishes and is kept. */
const command: CommandModule = {
    description: 'Stop an eval batch',
    args: [{ name: 'batch', description: 'The batch id', required: true }],
    run: withApi(async (_opts, ctx, args, api) => {
        const { batch } = await api.evals.stopEvalBatch(String(args[0]));
        ctx.logger.info(`batch ${batch.id} is ${batch.status}`);
        return 0;
    }),
};

export default command;
