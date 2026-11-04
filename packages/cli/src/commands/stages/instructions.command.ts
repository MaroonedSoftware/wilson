import type { CommandModule } from '@maroonedsoftware/johnny5';
import type { PatchLaneRequest } from '@wilson/sdk';
import { withApi } from '../../api-client.js';
import { withStepUp } from '../../sign.in.js';
import { editBody } from '../card/editor.js';

interface InstructionsOpts {
    message?: string;
    step?: string;
}

interface Step {
    name: string;
    instructions: string;
}

/**
 * Edit one lane's instructions in `$EDITOR`, with the conventions of `wilson card edit`: an editor
 * closed on an empty buffer abandons the edit, and an unchanged buffer writes nothing. The save asks
 * for the password (`withStepUp`), as every lane change does.
 */
const command: CommandModule<InstructionsOpts> = {
    description: "Edit a lane's instructions in $EDITOR",
    args: [{ name: 'lane', description: 'The lane to edit', required: true }],
    options: [
        { flags: '-m, --message <text>', description: 'What this change is, for the history', type: 'string' },
        { flags: '--step <name>', description: "Edit one of the lane's steps instead", type: 'string' },
    ],
    run: withApi<InstructionsOpts>(async (opts, ctx, args, api) => {
        const name = String(args[0]);
        const lanes = await api.stages.listLanes();
        const lane = lanes.find(candidate => candidate.name === name);
        if (!lane) {
            ctx.logger.error(`no lane named "${name}" (have: ${lanes.map(candidate => candidate.name).join(', ')})`);
            return 1;
        }

        const steps = (lane.settings as { steps?: Step[] }).steps ?? [];
        const step = steps.find(candidate => candidate.name === opts.step);
        if (opts.step !== undefined && !step) {
            ctx.logger.error(`${name} has no step named "${opts.step}" (have: ${steps.map(candidate => candidate.name).join(', ')})`);
            return 1;
        }
        const current = step?.instructions ?? lane.instructions;

        const instructions = await editBody(current, `wilson-${name}-instructions`);
        if (instructions === undefined) {
            ctx.logger.info('empty instructions — nothing written');
            return 1;
        }
        if (instructions === current) {
            ctx.logger.info('unchanged');
            return 0;
        }

        // A step's text lives in the lane's `steps` setting, and a setting is replaced whole, so the
        // other steps and this step's other fields go back as they were read.
        const patch = (
            step
                ? { settings: { steps: steps.map(candidate => (candidate === step ? { ...candidate, instructions } : candidate)) } }
                : { instructions }
        ) as PatchLaneRequest;
        const edited = step ? `${name} step ${step.name}` : name;
        await withStepUp(ctx, api, client => client.stages.updateLane(name, { ...patch, message: opts.message ?? `Edited ${edited} instructions` }));
        ctx.logger.info(`${edited}: instructions updated`);
        return 0;
    }),
};

export default command;
