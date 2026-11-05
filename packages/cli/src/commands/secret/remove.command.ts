import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';
import { withStepUp } from '../../sign.in.js';

const command: CommandModule = {
    description: 'Forget a secret',
    args: [{ name: 'name', description: 'The name it was saved under', required: true }],
    run: withApi(async (_opts, ctx, args, api) => {
        const name = String(args[0]);
        await withStepUp(ctx, api, client => client.secrets.removeSecret(name));
        ctx.logger.info(`${name} removed. Wilson forgetting it does not revoke it with whoever issued it.`);
        return 0;
    }),
};

export default command;
