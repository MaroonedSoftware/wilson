import { resolve } from 'node:path';
import { Registry } from 'injectkit';
import { AppConfig } from '@maroonedsoftware/appconfig';
import { ServerKitModule } from '@maroonedsoftware/koa';
import { BoardConfig, StaticBoardConfig } from './board.config.js';
import { BoardRepository } from './board.repository.js';
import { PostgresBoardRepository } from './postgres.board.repository.js';
import { BoardImporter } from './board.importer.js';
import { BoardService } from './board.service.js';
import { optionalConfigString, requireConfigString } from '#shared/require.config.js';

export const BoardModule: ServerKitModule = {
    name: 'Board',
    setup: async (registry: Registry, config: AppConfig) => {
        const codeRoot = resolve(requireConfigString(config, 'PROJECT_CODE_ROOT'));
        const boardRoot = resolve(requireConfigString(config, 'PROJECT_BOARD_ROOT'));

        registry.register(BoardConfig).useInstance(
            new StaticBoardConfig(
                optionalConfigString(config, 'PROJECT_NAME') ?? 'wilson',
                boardRoot,
                codeRoot,
                // Worktrees live beside the code repo rather than inside it, so a stray `git add
                // .` in a card's worktree cannot pick up a sibling card's tree.
                resolve(optionalConfigString(config, 'PROJECT_WORKTREE_ROOT') ?? `${codeRoot}/../.worktrees`),
                resolve(optionalConfigString(config, 'PROJECT_RUN_ROOT') ?? `${codeRoot}/../.run`),
            ),
        );

        // The board lives in Postgres. `boardRoot` is still resolved above because stage config is
        // still a file (`config/stages.yaml`) and `loadStages` reads it from there.
        registry.register(BoardRepository).useClass(PostgresBoardRepository).asTransient();
        registry.register(BoardImporter).useClass(BoardImporter).asTransient();
        registry.register(BoardService).useClass(BoardService).asTransient();
    },
};
