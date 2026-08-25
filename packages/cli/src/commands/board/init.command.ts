import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';

/**
 * Scaffold the board repo.
 *
 * The board is its own git repo beside the code repo, not a directory inside it (PROJECT.md, Board
 * format). Scaffolding it — `cards/`, `config/`, `context/`, a `stages.yaml`, and the git repo
 * itself — now happens behind `POST /api/board/init` (`BoardBootstrapService.init`, card 0076),
 * against whatever `PROJECT_BOARD_ROOT` the API itself is configured with; this command has no path
 * of its own to scaffold any more.
 */
const command: CommandModule = {
    description: 'Create the sibling board repo with its cards, config and context directories',
    run: withApi(async (_opts, ctx, _args, api) => {
        const columns = await api.board.initialiseBoard();

        ctx.logger.info(`board initialised — stages: ${columns.stages.join(', ') || '(none configured)'}`);
        ctx.logger.info('Write a card with `wilson card create <title>`, approve its plan, then `wilson card start <id>`.');
        return 0;
    }),
};

export default command;
