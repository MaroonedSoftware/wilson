import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';
import { withStepUp } from '../../sign.in.js';
import { editBody } from '../card/editor.js';

interface InstructionsOpts {
    message?: string;
}

/**
 * Edit one lane's instructions in `$EDITOR`, with the conventions of `wilson card edit`: an editor
 * closed on an empty buffer abandons the edit, and an unchanged buffer writes nothing. The save asks
 * for the password (`withStepUp`), as every lane change does.
 */
const command: CommandModule<InstructionsOpts> = {
    description: "Edit a lane's instructions in $EDITOR",
    args: [{ name: 'lane', description: 'The lane to edit', required: true }],
    options: [{ flags: '-m, --message <text>', description: 'What this change is, for the history', type: 'string' }],
    run: withApi<InstructionsOpts>(async (opts, ctx, args, api) => {
        const name = String(args[0]);
        const lanes = await api.stages.listLanes();
        const lane = lanes.find(candidate => candidate.name === name);
        if (!lane) {
            ctx.logger.error(`no lane named "${name}" (have: ${lanes.map(candidate => candidate.name).join(', ')})`);
            return 1;
        }

        const instructions = await editBody(lane.instructions, `wilson-${name}-instructions`);
        if (instructions === undefined) {
            ctx.logger.info('empty instructions — nothing written');
            return 1;
        }
        if (instructions === lane.instructions) {
            ctx.logger.info('unchanged');
            return 0;
        }

        await withStepUp(ctx, api, client =>
            client.stages.updateLane(name, { instructions, message: opts.message ?? `Edited ${name} instructions` }),
        );
        ctx.logger.info(`${name}: instructions updated`);
        return 0;
    }),
};

export default command;
