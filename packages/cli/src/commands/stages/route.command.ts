import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';
import { withStepUp } from '../../sign.in.js';

interface RouteOpts {
    adapter?: 'api' | 'cli' | 'codex';
    provider?: 'anthropic' | 'openai' | 'xai';
    model?: string;
    message?: string;
}

/**
 * Show or change which engine, provider and model a stage runs on.
 *
 * With no arguments it lists every stage. With a stage, any option left out keeps its current value,
 * so moving a stage to another model takes one flag. The API refuses a stage or provider that cannot
 * work, and the change needs the password, as `wilson stages edit` does (`withStepUp`).
 */
const command: CommandModule<RouteOpts> = {
    description: 'List stage routing, or set the adapter, provider and model of one stage',
    args: [{ name: 'stage', description: 'The stage to route. Leave out to list every stage' }],
    options: [
        { flags: '--adapter <adapter>', description: 'api, cli or codex', type: 'string' },
        { flags: '--provider <provider>', description: 'anthropic, openai or xai', type: 'string' },
        { flags: '--model <id>', description: 'The model id', type: 'string' },
        { flags: '-m, --message <text>', description: 'What this change is, for the history', type: 'string' },
    ],
    run: withApi<RouteOpts>(async (opts, ctx, args, api) => {
        const routes = await api.stages.listStageRouting();
        const stage = args[0] === undefined ? undefined : String(args[0]);

        if (stage === undefined) {
            for (const route of routes) {
                process.stdout.write(
                    `${route.stage.padEnd(16)} ${route.adapter.padEnd(5)} ${route.provider.padEnd(10)} ${route.model ?? '(none)'}\n`,
                );
            }
            return 0;
        }

        const current = routes.find(route => route.stage === stage);
        if (!current) {
            ctx.logger.error(`no stage named "${stage}" (have: ${routes.map(route => route.stage).join(', ')})`);
            return 1;
        }

        const adapter = opts.adapter ?? current.adapter;
        const provider = opts.provider ?? current.provider;
        const model = opts.model ?? current.model;
        if (!model) {
            ctx.logger.error(`${stage} has no model yet: name one with --model`);
            return 1;
        }
        await withStepUp(ctx, api, client => client.stages.setStageRouting(stage, { adapter, provider, model, message: opts.message }));
        ctx.logger.info(`${stage} now runs ${adapter} ${provider} ${model}`);
        return 0;
    }),
};

export default command;
