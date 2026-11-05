import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';

/** Turn down a proposed rule. */
const command: CommandModule = {
    description: 'Turn down a proposed rule',
    args: [{ name: 'proposal', description: 'The proposal, from `wilson rules proposals`', required: true }],
    run: withApi(async (_opts, ctx, args, api) => {
        const id = String(args[0]);
        await api.rules.declineRuleProposal(id);
        ctx.logger.info(`proposal ${id}: declined`);
        return 0;
    }),
};

export default command;
