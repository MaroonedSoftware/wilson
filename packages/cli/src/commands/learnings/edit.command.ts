import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';
import { editBody } from '../card/editor.js';

interface EditOpts {
    message?: string;
}

/**
 * Edit the project's learnings document in `$EDITOR`.
 *
 * The operator's way to approve a new learning now that the document is a row rather than a file —
 * the same shape as `wilson stages edit`, and the same conventions: an editor closed on an empty
 * buffer abandons the edit, an unchanged buffer writes nothing, and a save appends a version rather
 * than overwriting, so the previous document is still there (`wilson learnings versions`). Retiring
 * every learning at once (saving truly empty markdown) goes through `wilson learnings set` instead —
 * `editBody`'s own convention treats an empty buffer as "abandon", not "save empty" (PROJECT.md's
 * `git commit` precedent), so it cannot express that save.
 */
const command: CommandModule<EditOpts> = {
    description: "Edit the project's learnings document in $EDITOR",
    options: [{ flags: '-m, --message <text>', description: 'What this change is, for the history', type: 'string' }],
    run: withApi<EditOpts>(async (opts, ctx, _args, api) => {
        const before = await api.learnings.getLearnings();
        const markdown = await editBody(before.markdown, 'wilson-learnings');
        if (markdown === undefined) {
            ctx.logger.info('empty document — nothing written');
            return 1;
        }
        if (markdown === before.markdown) {
            ctx.logger.info('unchanged');
            return 0;
        }

        const saved = await api.learnings.setLearnings({ markdown, message: opts.message });
        ctx.logger.info(`learnings document updated (version ${saved.id})`);
        return 0;
    }),
};

export default command;
