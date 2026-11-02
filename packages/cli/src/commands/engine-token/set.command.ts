import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';
import { terminalIo } from '../../sign.in.js';

interface SetOpts {
    provider?: 'anthropic' | 'openai' | 'xai';
    kind?: 'subscription' | 'api_key';
    priority?: number;
}

/**
 * Save an engine token under a name (`PUT /api/engine-tokens/{name}`), replacing any saved there, so
 * rotating is running this again. The token comes from a hidden prompt or a pipe and never from an
 * argument, which `ps` and the shell's history would keep.
 */
const command: CommandModule = {
    description: 'Save an engine token under a name, replacing any there; reads it from a prompt or stdin',
    args: [{ name: 'name', description: 'The name to save it under', required: true }],
    options: [
        {
            flags: '--provider <provider>',
            description: 'Who it signs in to: anthropic, openai or xai (default: as saved, or anthropic)',
            type: 'string',
        },
        { flags: '--kind <kind>', description: 'How it signs in: subscription or api_key (default: as saved, or subscription)', type: 'string' },
        {
            flags: '--priority <n>',
            description: "Which of a provider's tokens comes first, lowest first, 0 to 1000 (default: as saved, or 0)",
            type: 'number',
        },
    ],
    run: withApi<SetOpts>(async (opts, ctx, args, api) => {
        const name = String(args[0]);
        const token = process.stdin.isTTY
            ? await terminalIo.askSecret(`The token for ${name}, from \`claude setup-token\``)
            : await terminalIo.readStdin();
        if (token === undefined) return 1;
        const saved = await api.engineTokens.putEngineToken(name, {
            token,
            ...(opts.provider !== undefined && { provider: opts.provider }),
            ...(opts.kind !== undefined && { kind: opts.kind }),
            ...(opts.priority !== undefined && { priority: opts.priority }),
        });
        const hosts = saved.hosts.length > 0 ? ` ${saved.hosts.join(', ')} will use it from the next engine started there.` : '';
        ctx.logger.info(`${name} saved.${hosts}`);
        return 0;
    }),
};

export default command;
