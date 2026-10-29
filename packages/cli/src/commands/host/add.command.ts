import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';
import { variableNames } from '../../host-view.js';

interface AddOpts {
    sshTarget?: string;
    slots?: number;
    lifetimeMinutes?: number;
    commandEnv?: string;
}

/**
 * Register a machine a card stage can run on (`POST /api/hosts`). The host serves no project until
 * `wilson host serve` says where that project's clone lives on it, so registering one places no
 * work on it.
 */
const command: CommandModule<AddOpts> = {
    description: 'Register a host a card stage can run on, reached over SSH',
    args: [{ name: 'name', description: 'The host name, e.g. agent-3', required: true }],
    options: [
        { flags: '--ssh-target <target>', description: 'What `ssh` connects to; defaults to the name', type: 'string' },
        { flags: '--slots <n>', description: 'Stages that may run on it at once, 1 to 8 (default 1)', type: 'number' },
        {
            flags: '--lifetime-minutes <n>',
            description: 'Minutes it runs after boot before it stops by itself (720 for an agent VM)',
            type: 'number',
        },
        {
            flags: '--command-env <names>',
            description: "Comma-separated variables the host's own environment gives setup, build and test commands, e.g. GITHUB_TOKEN",
            type: 'string',
        },
    ],
    run: withApi<AddOpts>(async (opts, ctx, args, api) => {
        const name = String(args[0]);
        const host = await api.hosts.registerHost({
            name,
            ...(opts.sshTarget !== undefined && { sshTarget: opts.sshTarget }),
            ...(opts.slots !== undefined && { slots: opts.slots }),
            ...(opts.lifetimeMinutes !== undefined && { lifetimeMinutes: opts.lifetimeMinutes }),
            ...(opts.commandEnv !== undefined && { commandEnv: variableNames(opts.commandEnv) }),
        });
        ctx.logger.info(`${host.name} registered (ssh ${host.sshTarget}, ${host.slots} slot${host.slots === 1 ? '' : 's'})`);
        return 0;
    }),
};

export default command;
