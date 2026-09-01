import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';
import { editBody } from '../card/editor.js';

interface EditOpts {
    message?: string;
}

/**
 * Edit the project's stage config in `$EDITOR`.
 *
 * The operator's way to change a stage's budget, route, prompt or allowed commands now that the
 * config is a row rather than a file — the same shape as `wilson card edit`, and the same
 * conventions: an editor closed on an empty buffer abandons the edit, an unchanged buffer writes
 * nothing, and a save appends a version rather than overwriting, so the previous document is still
 * there (`wilson stages versions`).
 *
 * Validation is the API's (`PUT /api/stages/config`): a document that does not parse, or routes to
 * a stage that does not exist, is refused with the validator's own reason and nothing is written.
 * Re-run to fix it — the editor opens on the *stored* document, not the refused one, which is a
 * real loss on a long edit; the workaround is `wilson stages show > stages.yaml`, edit the file,
 * `wilson stages set stages.yaml`.
 */
const command: CommandModule<EditOpts> = {
    description: "Edit the project's stage config in $EDITOR",
    options: [{ flags: '-m, --message <text>', description: 'What this change is, for the history', type: 'string' }],
    run: withApi<EditOpts>(async (opts, ctx, _args, api) => {
        const before = await api.stages.getStageConfig();
        const yaml = await editBody(before.yaml, 'wilson-stages');
        if (yaml === undefined) {
            ctx.logger.info('empty document — nothing written');
            return 1;
        }
        if (yaml === before.yaml) {
            ctx.logger.info('unchanged');
            return 0;
        }

        const saved = await api.stages.setStageConfig({ yaml, message: opts.message });
        ctx.logger.info(`stage config updated (version ${saved.id})`);
        return 0;
    }),
};

export default command;
