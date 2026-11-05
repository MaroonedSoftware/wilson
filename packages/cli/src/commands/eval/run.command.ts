import { readFile } from 'node:fs/promises';
import type { CommandModule } from '@maroonedsoftware/johnny5';
import type { LaneCandidate } from '@wilson/sdk';
import { parse } from 'yaml';
import { withApi } from '../../api-client.js';
import { withStepUp } from '../../sign.in.js';
import { renderBatch } from './report.js';

interface RunOpts {
    host: string;
    candidate?: string;
    runs?: number;
    maxOutputTokens?: number;
}

/**
 * Start a batch of eval runs (`POST /api/evals/batches`). It spends engine quota, so it needs the
 * password, as saving a lane does, and answers at once: `wilson eval show` reports it as it goes.
 */
const command: CommandModule<RunOpts> = {
    description: 'Run eval fixtures against the lanes as they stand, and optionally a candidate change',
    args: [{ name: 'fixtures', description: 'Fixture ids, separated by commas', required: true }],
    options: [
        { flags: '--host <name>', description: 'The host every run lands on', type: 'string', required: true },
        { flags: '--candidate <file>', description: 'A YAML file naming a lane and what to change on it', type: 'string' },
        { flags: '--runs <n>', description: 'Runs per fixture and arm. Defaults to 3', type: 'number' },
        { flags: '--max-output-tokens <n>', description: 'Stop the batch at this spend. Defaults to 300000', type: 'number' },
    ],
    run: withApi<RunOpts>(async (opts, ctx, args, api) => {
        const fixtureIds = String(args[0])
            .split(',')
            .map(id => id.trim())
            .filter(Boolean);
        const candidate = opts.candidate === undefined ? undefined : (parse(await readFile(opts.candidate, 'utf8')) as LaneCandidate);
        const detail = await withStepUp(ctx, api, client =>
            client.evals.createEvalBatch({
                fixtureIds,
                host: opts.host,
                ...(candidate && { candidate }),
                ...(opts.runs !== undefined && { runs: opts.runs }),
                ...(opts.maxOutputTokens !== undefined && { maxOutputTokens: opts.maxOutputTokens }),
            }),
        );
        process.stdout.write(renderBatch(detail));
        return 0;
    }),
};

export default command;
