import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';
import { variableNames } from '../../host-view.js';
import { withStepUp } from '../../sign.in.js';

interface AddOpts {
    worker?: boolean;
    sshTarget?: string;
    slots?: number;
    lifetimeMinutes?: number;
    commandEnv?: string;
    projectsRoot?: string;
}

/**
 * Register a machine a card stage can run on (`POST /api/hosts`). The host serves no project until
 * `wilson host serve` says where that project's clone lives on it, so registering one places no
 * work on it. `--worker` registers one whose worker program connects in, rather than one reached
 * over SSH; it takes no `--ssh-target`.
 *
 * Registering needs a factor proved in the last five minutes (`wilson.step.up`), which this machine's
 * API key never is, so it asks for the password (`withStepUp`). A leaked key cannot add a host of its
 * own to send card work to.
 */
const command: CommandModule<AddOpts> = {
    description: 'Register a host a card stage can run on, reached over SSH or by a worker that connects in',
    args: [{ name: 'name', description: 'The host name, e.g. agent-3', required: true }],
    options: [
        { flags: '--worker', description: 'A host whose worker program connects in, rather than one reached over SSH', type: 'boolean' },
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
        {
            flags: '--projects-root <path>',
            description: 'Absolute path on the host any project with a GitHub repository can add itself under',
            type: 'string',
        },
    ],
    run: withApi<AddOpts>(async (opts, ctx, args, api) => {
        const name = String(args[0]);
        const host = await withStepUp(ctx, api, client =>
            client.hosts.registerHost({
                name,
                ...(opts.worker && { kind: 'worker' as const }),
                ...(opts.sshTarget !== undefined && { sshTarget: opts.sshTarget }),
                ...(opts.slots !== undefined && { slots: opts.slots }),
                ...(opts.lifetimeMinutes !== undefined && { lifetimeMinutes: opts.lifetimeMinutes }),
                ...(opts.commandEnv !== undefined && { commandEnv: variableNames(opts.commandEnv) }),
                ...(opts.projectsRoot !== undefined && { projectsRoot: opts.projectsRoot }),
            }),
        );
        const reached = host.kind === 'worker' ? 'worker' : `ssh ${host.sshTarget}`;
        ctx.logger.info(`${host.name} registered (${reached}, ${host.slots} slot${host.slots === 1 ? '' : 's'})`);
        return 0;
    }),
};

export default command;
