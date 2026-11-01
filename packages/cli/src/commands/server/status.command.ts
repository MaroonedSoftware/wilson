import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';
import { describeDrain } from '../../drain-view.js';

/** Whether the server is draining, what it is still running, and whether a restart is safe yet. */
const command: CommandModule = {
    description: 'Show whether the server is draining and whether a restart is safe',
    run: withApi(async (_opts, ctx, _args, api) => {
        ctx.logger.info(describeDrain(await api.settings.getDrainStatus()));
        return 0;
    }),
};

export default command;
