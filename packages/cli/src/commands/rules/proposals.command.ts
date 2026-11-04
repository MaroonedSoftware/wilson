import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';

/** Print the rules proposed from past kickbacks, waiting on a person. None of them is checked until accepted. */
const command: CommandModule = {
    description: 'Print the rules proposed from past kickbacks',
    run: withApi(async (_opts, ctx, _args, api) => {
        const proposals = await api.rules.listRuleProposals();
        if (proposals.length === 0) {
            ctx.logger.info('no proposals');
            return 0;
        }
        for (const proposal of proposals) {
            process.stdout.write(
                `${proposal.id}  from card ${proposal.cardId}  ${proposal.paths.join(' ')}\n    ${proposal.statement}\n    Why: ${proposal.reason}\n`,
            );
        }
        return 0;
    }),
};

export default command;
