import type { CommandModule } from '@maroonedsoftware/johnny5';
import type { PatchLaneRequest } from '@wilson/sdk';
import { withApi } from '../../api-client.js';
import { withStepUp } from '../../sign.in.js';

interface SetOpts {
    message?: string;
    unset?: boolean;
}

/** The lane fields with a column of their own. Anything else is a setting. */
const COLUMNS = ['mode', 'worktree', 'onPass', 'onFail', 'instructions'];

/** A value on the command line: JSON when it reads as JSON, so `80` and `["pnpm test"]` work, otherwise text. */
const parseValue = (raw: string): unknown => {
    try {
        return JSON.parse(raw);
    } catch {
        return raw;
    }
};

/**
 * Set one field of a lane (`wilson stages set review maxSteps 150`), or remove a setting with
 * `--unset`, back to its default. Validated by the API, and nothing is written when it is refused. The
 * save asks for the password (`withStepUp`).
 */
const command: CommandModule<SetOpts> = {
    description: 'Set one field of a lane',
    args: [
        { name: 'lane', description: 'The lane to change', required: true },
        { name: 'field', description: 'The field to set', required: true },
        { name: 'value', description: 'The new value, as JSON or plain text' },
    ],
    options: [
        { flags: '-m, --message <text>', description: 'What this change is, for the history', type: 'string' },
        { flags: '--unset', description: 'Remove the setting, back to its default', type: 'boolean' },
    ],
    run: withApi<SetOpts>(async (opts, ctx, args, api) => {
        const lane = String(args[0]);
        const field = String(args[1]);
        if (opts.unset ? COLUMNS.includes(field) : args[2] === undefined) {
            ctx.logger.error(opts.unset ? `${field} cannot be unset` : `give a value for ${field}, or --unset to remove it`);
            return 1;
        }
        const value = opts.unset ? null : COLUMNS.includes(field) ? String(args[2]) : parseValue(String(args[2]));
        const patch = (COLUMNS.includes(field) ? { [field]: value } : { settings: { [field]: value } }) as PatchLaneRequest;
        await withStepUp(ctx, api, client => client.stages.updateLane(lane, { ...patch, message: opts.message ?? `Set ${lane} ${field}` }));
        ctx.logger.info(opts.unset ? `${lane}: ${field} removed` : `${lane}: ${field} set`);
        return 0;
    }),
};

export default command;
