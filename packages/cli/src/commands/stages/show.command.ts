import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';

/**
 * Print the project's lanes in board order, or one lane in full: its columns, its settings as JSON,
 * then its instructions.
 */
const command: CommandModule = {
    description: "Print the project's lanes, or one lane in full",
    args: [{ name: 'lane', description: 'One lane to print. Leave out to list them all' }],
    run: withApi(async (_opts, ctx, args, api) => {
        const lanes = await api.stages.listLanes();
        if (args[0] === undefined) {
            for (const lane of lanes) {
                const route = `${lane.onPass} / ${lane.onFail}`;
                process.stdout.write(`${lane.name.padEnd(16)} ${lane.mode.padEnd(8)} ${(lane.model ?? '(no model)').padEnd(20)} ${route}\n`);
            }
            return 0;
        }

        const name = String(args[0]);
        const lane = lanes.find(candidate => candidate.name === name);
        if (!lane) {
            ctx.logger.error(`no lane named "${name}" (have: ${lanes.map(candidate => candidate.name).join(', ')})`);
            return 1;
        }
        const { instructions, settings, position: _position, ...columns } = lane;
        for (const [key, value] of Object.entries(columns)) process.stdout.write(`${key}: ${String(value)}\n`);
        process.stdout.write(`settings: ${JSON.stringify(settings, undefined, 2)}\ninstructions:\n${instructions}\n`);
        return 0;
    }),
};

export default command;
