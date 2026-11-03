import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';

/**
 * Print the project's stage config — the document that used to be `config/stages.yaml` in the board
 * repo, and is a `wilson.stage_configs` row now (`GET /api/stages/config`).
 *
 * Written to stdout verbatim rather than through the logger, so `wilson stages show > stages.yaml`
 * round-trips: the file it produces is exactly what `wilson stages set` accepts.
 *
 * With a lane, prints that lane instead: its columns, its settings as JSON, then its instructions.
 */
const command: CommandModule = {
    description: "Print the project's stage config",
    args: [{ name: 'lane', description: 'One lane to print. Leave out for the whole config' }],
    run: withApi(async (_opts, ctx, args, api) => {
        if (args[0] !== undefined) {
            const name = String(args[0]);
            const lanes = await api.stages.listLanes();
            const lane = lanes.find(candidate => candidate.name === name);
            if (!lane) {
                ctx.logger.error(`no lane named "${name}" (have: ${lanes.map(candidate => candidate.name).join(', ')})`);
                return 1;
            }
            const { instructions, settings, position: _position, ...columns } = lane;
            for (const [key, value] of Object.entries(columns)) process.stdout.write(`${key}: ${String(value)}\n`);
            process.stdout.write(`settings: ${JSON.stringify(settings, undefined, 2)}\ninstructions:\n${instructions}\n`);
            return 0;
        }

        const document = await api.stages.getStageConfig();
        process.stdout.write(document.yaml.endsWith('\n') ? document.yaml : `${document.yaml}\n`);
        return 0;
    }),
};

export default command;
