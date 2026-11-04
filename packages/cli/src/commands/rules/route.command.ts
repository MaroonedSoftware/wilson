import type { CommandModule } from '@maroonedsoftware/johnny5';
import type { RuleJudgeSetting } from '@wilson/sdk';
import { withApi } from '../../api-client.js';
import { withStepUp } from '../../sign.in.js';

/**
 * Print or set which engine and model judge the project's rules, apart from any lane's routing. Saving
 * asks for the password (`withStepUp`).
 */
const command: CommandModule = {
    description: "Print or set the rule judges' engine and model",
    args: [
        { name: 'engine', description: 'api or cli. Leave out to print the current route' },
        { name: 'provider', description: 'anthropic, openai or xai. cli always runs Claude' },
        { name: 'model', description: 'The model to judge on' },
    ],
    run: withApi(async (_opts, ctx, args, api) => {
        if (args[0] === undefined) {
            const route = await api.settings.getRuleJudgeSetting();
            process.stdout.write(`${route.engine}  ${route.provider}  ${route.model}\n`);
            return 0;
        }
        if (args[2] === undefined) {
            ctx.logger.error('give an engine, a provider and a model, or nothing to print the current route');
            return 1;
        }
        const route = { engine: String(args[0]), provider: String(args[1]), model: String(args[2]) } as RuleJudgeSetting;
        await withStepUp(ctx, api, client => client.settings.setRuleJudgeSetting(route));
        ctx.logger.info(`rule judges: ${route.engine} ${route.provider} ${route.model}`);
        return 0;
    }),
};

export default command;
