import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';
import { withStepUp } from '../../sign.in.js';
import { renderBatch } from './report.js';

interface RunOpts {
    host: string;
    runs?: number;
    maxOutputTokens?: number;
}

/**
 * Start a batch of eval runs (`POST /api/evals/batches`). It spends engine quota, so it needs the
 * password, as saving a lane does, and answers at once: `wilson eval show` reports it as it goes.
 */
const command: CommandModule<RunOpts> = {
    description: 'Run eval fixtures against the lanes as they stand',
    args: [{ name: 'fixtures', description: 'Fixture ids, separated by commas', required: true }],
    options: [
        { flags: '--host <name>', description: 'The host every run lands on', type: 'string', required: true },
        { flags: '--runs <n>', description: 'Runs per fixture. Defaults to 3', type: 'number' },
        { flags: '--max-output-tokens <n>', description: 'Stop the batch at this spend. Defaults to 300000', type: 'number' },
    ],
    run: withApi<RunOpts>(async (opts, ctx, args, api) => {
        const fixtureIds = String(args[0])
            .split(',')
            .map(id => id.trim())
            .filter(Boolean);
        const detail = await withStepUp(ctx, api, client =>
            client.evals.createEvalBatch({
                fixtureIds,
                host: opts.host,
                ...(opts.runs !== undefined && { runs: opts.runs }),
                ...(opts.maxOutputTokens !== undefined && { maxOutputTokens: opts.maxOutputTokens }),
            }),
        );
        process.stdout.write(renderBatch(detail));
        return 0;
    }),
};

export default command;
