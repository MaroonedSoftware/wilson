import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';

/** Print the project's checked rules: id, severity, the paths each is about, then what it says. */
const command: CommandModule = {
    description: "Print the project's checked rules",
    run: withApi(async (_opts, ctx, _args, api) => {
        const rules = await api.rules.listRules();
        if (rules.length === 0) {
            ctx.logger.info('no rules');
            return 0;
        }
        for (const rule of rules) {
            process.stdout.write(`${rule.id}  ${rule.severity}  ${rule.paths.join(' ')}\n    ${rule.statement}\n`);
        }
        return 0;
    }),
};

export default command;
