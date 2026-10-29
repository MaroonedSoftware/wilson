import { readFile } from 'node:fs/promises';
import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';
import { withStepUp } from '../../sign.in.js';

interface SetOpts {
    message?: string;
}

/**
 * Replace the project's stage config with the contents of a file.
 *
 * The one-shot path: importing a board repo's `config/stages.yaml` into a project that has none,
 * or applying an edit made in a real editor session outside `$EDITOR`. The file is sent as-is and
 * validated by the API, exactly as `wilson stages edit` is; nothing is written when it is refused.
 * Like `edit`, the save asks for the password (`withStepUp`).
 */
const command: CommandModule<SetOpts> = {
    description: "Replace the project's stage config with a file's contents",
    args: [{ name: 'file', description: 'Path to a stage config document (YAML)', required: true }],
    options: [{ flags: '-m, --message <text>', description: 'What this change is, for the history', type: 'string' }],
    run: withApi<SetOpts>(async (opts, ctx, args, api) => {
        const path = String(args[0]);
        const yaml = await readFile(path, 'utf8');

        const saved = await withStepUp(ctx, api, client => client.stages.setStageConfig({ yaml, message: opts.message ?? `Set from ${path}` }));
        ctx.logger.info(`stage config updated from ${path} (version ${saved.id})`);
        return 0;
    }),
};

export default command;
