import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';
import { describeDrain } from '../../drain-view.js';

/** End a drain. Held stages start on their next wake-up, within about 30 seconds. */
const command: CommandModule = {
    description: 'End a drain so stages start again',
    run: withApi(async (_opts, ctx, _args, api) => {
        ctx.logger.info(describeDrain(await api.settings.setDrain({ draining: false })));
        return 0;
    }),
};

export default command;
