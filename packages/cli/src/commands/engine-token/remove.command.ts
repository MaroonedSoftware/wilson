import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';

const command: CommandModule = {
    description: 'Forget an engine token. Hosts assigned it go back to their own sign-in',
    args: [{ name: 'name', description: 'The name it was saved under', required: true }],
    run: withApi(async (_opts, ctx, args, api) => {
        const name = String(args[0]);
        await api.engineTokens.removeEngineToken(name);
        ctx.logger.info(`${name} removed. An engine already running keeps it, and Wilson forgetting it does not revoke it with Anthropic.`);
        return 0;
    }),
};

export default command;
