import { readFile } from 'node:fs/promises';
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
 * Replace the project's stage config with the contents of a file.
 *
 * The one-shot path: importing a board repo's `config/stages.yaml` into a project that has none,
 * or applying an edit made in a real editor session outside `$EDITOR`. The file is sent as-is and
 * validated by the API, exactly as `wilson stages edit` is; nothing is written when it is refused.
 * Like `edit`, the save asks for the password (`withStepUp`).
 *
 * With a lane and a field, sets that one field instead (`wilson stages set review maxSteps 150`), or
 * removes a setting with `--unset`.
 */
const command: CommandModule<SetOpts> = {
    description: "Set one field of a lane, or replace the project's stage config with a file's contents",
    args: [
        { name: 'file', description: 'A lane, or the path to a stage config document (YAML)', required: true },
        { name: 'field', description: 'The field of the lane to set' },
        { name: 'value', description: 'The new value, as JSON or plain text' },
    ],
    options: [
        { flags: '-m, --message <text>', description: 'What this change is, for the history', type: 'string' },
        { flags: '--unset', description: 'Remove the setting, back to its default', type: 'boolean' },
    ],
    run: withApi<SetOpts>(async (opts, ctx, args, api) => {
        if (args[1] !== undefined) {
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
        }

        const path = String(args[0]);
        const yaml = await readFile(path, 'utf8');

        const saved = await withStepUp(ctx, api, client => client.stages.setStageConfig({ yaml, message: opts.message ?? `Set from ${path}` }));
        ctx.logger.info(`stage config updated from ${path} (version ${saved.id})`);
        return 0;
    }),
};

export default command;
