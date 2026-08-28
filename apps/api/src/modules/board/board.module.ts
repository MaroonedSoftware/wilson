import { resolve } from 'node:path';
import { Registry } from 'injectkit';
import { Kysely, PostgresDialect } from 'kysely';
import { AppConfig } from '@maroonedsoftware/appconfig';
import { ServerKitModule } from '@maroonedsoftware/koa';
import { ConsoleLogger } from '@maroonedsoftware/logger';
import { KyselyDefaultPlugins, KyselyPgTypeOverrides, KyselyPool } from '@maroonedsoftware/kysely';
import type { DB } from '#modules/data/db.js';
import { BoardConfig, StaticBoardConfig } from './board.config.js';
import { BoardRepository } from './board.repository.js';
import { PostgresBoardRepository } from './postgres.board.repository.js';
import { ProjectRepository, type ProjectRow } from './project.repository.js';
import { BoardImporter } from './board.importer.js';
import { BoardBootstrapService } from './board.bootstrap.service.js';
import { BoardService } from './board.service.js';
import { BoardWriteService } from './board.write.service.js';
import { PlanService } from '#modules/plan/plan.service.js';
import { configNumber, optionalConfigString, requireConfigString } from '#shared/require.config.js';

/**
 * The configured project's row from `runner.projects` — created from the environment on a first
 * boot, used unchanged on every boot after.
 *
 * `BoardModule.setup` only receives a `Registry`, not a `Container`: `ServerKitServerBuilder.setup`
 * awaits every module's `setup` hook before building the container from the registrations they
 * made, so `DataModule`'s pooled `Kysely<DB>` singleton (registered in that same pass) is not
 * resolvable here yet. This opens its own short-lived connection instead, using the same
 * `DATABASE_*` variables `DataModule` does, and closes it before returning.
 *
 * Once a row exists it wins over the environment outright: `find` either returns it as-is or this
 * never runs `create` at all. There is no comparison against `fromEnv` and no merge — an operator
 * who edits the row and then restarts with stale (or since-changed) environment variables gets the
 * row's values, not whichever the shell that happened to start the daemon carried, and not some
 * combination of the two.
 */
const resolveProjectRow = async (config: AppConfig, name: string, fromEnv: Omit<ProjectRow, 'name'>): Promise<Omit<ProjectRow, 'name'>> => {
    const pool = new KyselyPool({
        host: requireConfigString(config, 'DATABASE_HOST'),
        port: configNumber(config, 'DATABASE_PORT', 5432),
        user: requireConfigString(config, 'DATABASE_USER'),
        password: requireConfigString(config, 'DATABASE_PASSWORD'),
        database: requireConfigString(config, 'DATABASE_NAME'),
        types: KyselyPgTypeOverrides,
    });
    // No injected Logger exists yet either (it too comes from the container) — a directly
    // constructed one is the same fallback `setupServer` uses for its own boot-time logging,
    // before `serverBuilder.setup` has run.
    pool.on('error', err => new ConsoleLogger().error(err));

    const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }), plugins: [...KyselyDefaultPlugins] });
    try {
        const repo = new ProjectRepository(db);
        const existing = await repo.find(name);
        if (existing) {
            const { boardRoot, codeRoot, worktreeRoot, runRoot } = existing;
            return { boardRoot, codeRoot, worktreeRoot, runRoot };
        }
        await repo.create({ name, ...fromEnv });
        return fromEnv;
    } finally {
        await db.destroy();
    }
};

export const BoardModule: ServerKitModule = {
    name: 'Board',
    setup: async (registry: Registry, config: AppConfig) => {
        const codeRoot = resolve(requireConfigString(config, 'PROJECT_CODE_ROOT'));
        const boardRoot = resolve(requireConfigString(config, 'PROJECT_BOARD_ROOT'));
        const projectName = optionalConfigString(config, 'PROJECT_NAME') ?? 'wilson';
        const paths = await resolveProjectRow(config, projectName, {
            boardRoot,
            codeRoot,
            // Worktrees live beside the code repo rather than inside it, so a stray `git add .`
            // in a card's worktree cannot pick up a sibling card's tree.
            worktreeRoot: resolve(optionalConfigString(config, 'PROJECT_WORKTREE_ROOT') ?? `${codeRoot}/../.worktrees`),
            runRoot: resolve(optionalConfigString(config, 'PROJECT_RUN_ROOT') ?? `${codeRoot}/../.run`),
        });

        registry.register(BoardConfig).useInstance(
            new StaticBoardConfig(
                projectName,
                paths.boardRoot,
                paths.codeRoot,
                paths.worktreeRoot,
                paths.runRoot,
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
