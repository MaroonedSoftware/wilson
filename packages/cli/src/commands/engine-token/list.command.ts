import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';

const command: CommandModule = {
    description: 'List the engine tokens Wilson holds, by name, and the worker hosts assigned each',
    run: withApi(async (_opts, ctx, _args, api) => {
        const tokens = await api.engineTokens.listEngineTokens();
        if (tokens.length === 0) {
            ctx.logger.info('no engine tokens yet: `wilson engine-token set <name>` saves one');
            return 0;
        }
        for (const token of tokens) {
            const hosts = token.hosts.length > 0 ? `  assigned to ${token.hosts.join(', ')}` : '  assigned to no host';
            ctx.logger.info(`${token.name}  saved ${token.updatedAt.toUTC().toISO({ suppressMilliseconds: true })}${hosts}`);
        }
        return 0;
    }),
};

export default command;
