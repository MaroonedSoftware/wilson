import { resolve } from 'node:path';
import { Registry } from 'injectkit';
import { AppConfig } from '@maroonedsoftware/appconfig';
import { ServerKitModule } from '@maroonedsoftware/koa';
import { BoardConfig, StaticBoardConfig } from './board.config.js';
import { BoardRepository } from './board.repository.js';
import { PostgresBoardRepository } from './postgres.board.repository.js';
import { BoardImporter } from './board.importer.js';
import { BoardBootstrapService } from './board.bootstrap.service.js';
import { BoardService } from './board.service.js';
import { BoardWriteService } from './board.write.service.js';
import { PlanService } from '#modules/plan/plan.service.js';
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
                // Card 0050: both optional, and off (no webhook attempted) when NOTIFY_WEBHOOK_URL
                // is unset.
                optionalConfigString(config, 'NOTIFY_WEBHOOK_URL'),
                optionalConfigString(config, 'NOTIFY_BASE_URL'),
            ),
        );

        // The board lives in Postgres. `boardRoot` is still resolved above because stage config is
        // still a file (`config/stages.yaml`) and `loadStages` reads it from there.
        registry.register(BoardRepository).useClass(PostgresBoardRepository).asTransient();
        registry.register(BoardImporter).useClass(BoardImporter).asTransient();
        registry.register(BoardBootstrapService).useClass(BoardBootstrapService).asTransient();
        registry.register(BoardService).useClass(BoardService).asTransient();
        registry.register(BoardWriteService).useClass(BoardWriteService).asTransient();
        // Registered here rather than its own module: `modules.ts` is the module list, and adding a
        // one-line entry there for a single service is out of scope for card 0077 (see its plan).
        // `WorktreeModule` registers `WorktreeManager` this service depends on — order doesn't matter
        // here, `setup` only registers tokens, it does not resolve them.
        registry.register(PlanService).useClass(PlanService).asTransient();
    },
};
