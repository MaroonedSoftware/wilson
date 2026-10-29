import type { CommandModule } from '@maroonedsoftware/johnny5';
import type { UpdateHostRequest } from '@wilson/sdk';
import { withApi } from '../../api-client.js';
import { describeHost, variableNames } from '../../host-view.js';

interface SetOpts {
    sshTarget?: string;
    slots?: number;
    lifetimeMinutes?: number;
    commandEnv?: string;
    enable?: boolean;
    disable?: boolean;
    drain?: boolean;
    undrain?: boolean;
}

/**
 * Change a registered host (`PATCH /api/hosts/{name}`). Only the options given change.
 *
 * `--disable` takes the host out of consideration altogether; `--drain` stops new stages landing on
 * it but lets the ones already there finish, which is how a VM is emptied before it is deleted.
 */
const command: CommandModule<SetOpts> = {
    description: "Change a host's SSH target, slots, or whether it takes work",
    args: [{ name: 'name', description: 'The host name', required: true }],
    options: [
        { flags: '--ssh-target <target>', description: 'What `ssh` connects to (not for a worker host)', type: 'string' },
        { flags: '--slots <n>', description: 'Stages that may run on it at once, 1 to 8', type: 'number' },
        { flags: '--lifetime-minutes <n>', description: 'Minutes it runs after boot before it stops by itself; 0 clears it', type: 'number' },
        {
            flags: '--command-env <names>',
            description:
                "Comma-separated variables the host's own environment gives setup, build and test commands, replacing the list; empty clears it",
            type: 'string',
        },
        { flags: '--enable', description: 'Let it take work again', type: 'boolean' },
        { flags: '--disable', description: 'Stop it taking work and stop probing it', type: 'boolean' },
        { flags: '--drain', description: 'Take no new stage, but let running ones finish', type: 'boolean' },
        { flags: '--undrain', description: 'Take new stages again', type: 'boolean' },
    ],
    run: withApi<SetOpts>(async (opts, ctx, args, api) => {
        const name = String(args[0]);
        if (opts.enable && opts.disable) {
            ctx.logger.error('--enable and --disable contradict each other; pass one');
            return 1;
        }
        if (opts.drain && opts.undrain) {
            ctx.logger.error('--drain and --undrain contradict each other; pass one');
            return 1;
        }

        const patch: UpdateHostRequest = {
            ...(opts.sshTarget !== undefined && { sshTarget: opts.sshTarget }),
            ...(opts.slots !== undefined && { slots: opts.slots }),
            ...(opts.lifetimeMinutes !== undefined && { lifetimeMinutes: opts.lifetimeMinutes }),
            ...(opts.commandEnv !== undefined && { commandEnv: variableNames(opts.commandEnv) }),
            ...((opts.enable || opts.disable) && { enabled: !!opts.enable }),
            ...((opts.drain || opts.undrain) && { draining: !!opts.drain }),
        };
        if (Object.keys(patch).length === 0) {
            ctx.logger.error('nothing to change: pass at least one option');
            return 1;
        }

        const host = await api.hosts.updateHost(name, patch);
        for (const line of describeHost(host)) ctx.logger.info(line);
        return 0;
    }),
};

export default command;
