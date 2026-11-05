import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';

const command: CommandModule = {
    description: 'List the secrets Wilson holds, by name. Never shows a value',
    run: withApi(async (_opts, ctx, _args, api) => {
        const secrets = await api.secrets.listSecrets();
        if (secrets.length === 0) ctx.logger.info('no secrets yet: `wilson secret set <name>` saves one');
        for (const secret of secrets) {
            const used = secret.connections.length > 0 ? `  used by ${secret.connections.join(', ')}` : '';
            ctx.logger.info(`${secret.name}  saved ${secret.updatedAt.toUTC().toISO({ suppressMilliseconds: true })}${used}`);
        }
        return 0;
    }),
};

export default command;
