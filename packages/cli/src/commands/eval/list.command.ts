import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';

/** List recent eval batches, newest first (`GET /api/evals/batches`). */
const command: CommandModule = {
    description: 'List eval batches',
    run: withApi(async (_opts, _ctx, _args, api) => {
        for (const batch of await api.evals.listEvalBatches({})) {
            process.stdout.write(
                `${batch.id.padEnd(6)} ${batch.status.padEnd(9)} ${batch.host.padEnd(16)} ${batch.spentOutputTokens}/${batch.maxOutputTokens}\n`,
            );
        }
        return 0;
    }),
};

export default command;
