import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';
import { withStepUp } from '../../sign.in.js';

interface AcceptOpts {
    severity?: 'blocker' | 'concern';
}

/** Make a proposed rule a real one, under a name of your choosing. The save asks for the password (`withStepUp`). */
const command: CommandModule<AcceptOpts> = {
    description: 'Make a proposed rule a real one',
    args: [
        { name: 'proposal', description: 'The proposal, from `wilson rules proposals`', required: true },
        { name: 'id', description: 'A short name for the rule: lower-case letters, digits and hyphens', required: true },
    ],
    options: [{ flags: '--severity <severity>', description: 'blocker (default) can send a card back; concern only reports', type: 'string' }],
    run: withApi<AcceptOpts>(async (opts, ctx, args, api) => {
        const id = String(args[1]);
        await withStepUp(ctx, api, client =>
            client.rules.acceptRuleProposal(String(args[0]), { id, ...(opts.severity ? { severity: opts.severity } : {}) }),
        );
        ctx.logger.info(`${id}: added`);
        return 0;
    }),
};

export default command;
