import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';

/**
 * Give the project its first stage config.
 *
 * This used to scaffold the sibling board repo — `cards/`, `config/`, `context/`, a `stages.yaml`,
 * and the git repo itself. The board is Postgres now, stage config included, so all that is left
 * to initialise is the `runner.stage_configs` row holding a default document an operator can start
 * a card against immediately (`BoardBootstrapService.init`, behind `POST /api/board/init`). It is
 * keyed by the project the request is for (`WILSON_PROJECT`, or the daemon's own), and refuses a
 * project that already has one — `wilson stages edit` is how a config changes from here.
 */
const command: CommandModule = {
    description: 'Give the project its first stage config',
    run: withApi(async (_opts, ctx, _args, api) => {
        const columns = await api.board.initialiseBoard();

        ctx.logger.info(`board initialised — stages: ${columns.stages.join(', ') || '(none configured)'}`);
        ctx.logger.info('Write a card with `wilson card create <title>`, approve its plan, then `wilson card start <id>`.');
        return 0;
    }),
};

export default command;
