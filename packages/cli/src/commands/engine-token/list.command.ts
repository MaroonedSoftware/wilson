import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';

const command: CommandModule = {
    description: 'List the engine tokens Wilson holds, by name, with the worker hosts assigned each and any usage limit in force',
    run: withApi(async (_opts, ctx, _args, api) => {
        const [tokens, limits] = await Promise.all([api.engineTokens.listEngineTokens(), api.engineTokens.listEngineLimits()]);
        const limitsOf = (account: string) =>
            limits
                .filter(limit => limit.account === account)
                .map(limit => `  ${limit.limitType} limit until ${limit.resetsAt.toUTC().toISO({ suppressMilliseconds: true })}`)
                .join('');
        if (tokens.length === 0) ctx.logger.info('no engine tokens yet: `wilson engine-token set <name>` saves one');
        for (const token of tokens) {
            const hosts = token.hosts.length > 0 ? `  assigned to ${token.hosts.join(', ')}` : '  assigned to no host';
            const account = `${token.provider} ${token.kind}  priority ${token.priority}${token.pooled ? '  pooled' : ''}`;
            ctx.logger.info(
                `${token.name}  ${account}  saved ${token.updatedAt.toUTC().toISO({ suppressMilliseconds: true })}${hosts}${limitsOf(token.name)}`,
            );
        }
        // A limit on a sign-in Wilson holds no token for: this machine's, or a worker's own.
        const saved = new Set(tokens.map(token => token.name));
        for (const account of new Set(limits.map(limit => limit.account))) {
            if (!saved.has(account)) ctx.logger.info(`${account}${limitsOf(account)}`);
        }
        return 0;
    }),
};

export default command;
