import { readFile } from 'node:fs/promises';
import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';

interface SetOpts {
    message?: string;
}

/**
 * Replace the project's learnings document with the contents of a file.
 *
 * The one-shot path: importing a document written outside `$EDITOR`, or retiring every learning at
 * once by pointing this at an empty file — `wilson learnings edit` cannot express that save, since
 * an empty editor buffer means "abandon" there (see that command's own doc comment).
 */
const command: CommandModule<SetOpts> = {
    description: "Replace the project's learnings document with a file's contents",
    args: [{ name: 'file', description: 'Path to a learnings document (Markdown)', required: true }],
    options: [{ flags: '-m, --message <text>', description: 'What this change is, for the history', type: 'string' }],
    run: withApi<SetOpts>(async (opts, ctx, args, api) => {
        const path = String(args[0]);
        const markdown = await readFile(path, 'utf8');

        const saved = await api.learnings.setLearnings({ markdown, message: opts.message ?? `Set from ${path}` });
        ctx.logger.info(`learnings document updated from ${path} (version ${saved.id})`);
        return 0;
    }),
};

export default command;
