import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';
import { renderBatch } from './report.js';

/** Report an eval batch (`GET /api/evals/batches/{id}`). */
const command: CommandModule = {
    description: 'Report an eval batch',
    args: [{ name: 'batch', description: 'The batch id', required: true }],
    run: withApi(async (_opts, _ctx, args, api) => {
        process.stdout.write(renderBatch(await api.evals.getEvalBatch(String(args[0]))));
        return 0;
    }),
};

export default command;
