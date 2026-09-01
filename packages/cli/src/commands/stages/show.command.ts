import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';

/**
 * Print the project's stage config — the document that used to be `config/stages.yaml` in the board
 * repo, and is a `runner.stage_configs` row now (`GET /api/stages/config`).
 *
 * Written to stdout verbatim rather than through the logger, so `wilson stages show > stages.yaml`
 * round-trips: the file it produces is exactly what `wilson stages set` accepts.
 */
const command: CommandModule = {
    description: "Print the project's stage config",
    run: withApi(async (_opts, _ctx, _args, api) => {
        const document = await api.stages.getStageConfig();
        process.stdout.write(document.yaml.endsWith('\n') ? document.yaml : `${document.yaml}\n`);
        return 0;
    }),
};

export default command;
