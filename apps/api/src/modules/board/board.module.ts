import { resolve } from 'node:path';
import { Container, Registry } from 'injectkit';
import { Kysely, PostgresDialect } from 'kysely';
import { AppConfig } from '@maroonedsoftware/appconfig';
import { ServerKitModule } from '@maroonedsoftware/koa';
import { ConsoleLogger, Logger } from '@maroonedsoftware/logger';
import { KyselyDefaultPlugins, KyselyPgTypeOverrides, KyselyPool } from '@maroonedsoftware/kysely';
import type { DB } from '#modules/data/db.js';
import { BoardConfig, ProjectScopedBoardConfig } from './board.config.js';
import { BoardRepository } from './board.repository.js';
import { PostgresBoardRepository } from './postgres.board.repository.js';
import { ProjectRepository, type ProjectRow } from './project.repository.js';
import { BoardBootstrapService } from './board.bootstrap.service.js';
import { BoardService } from './board.service.js';
import { BoardWriteService } from './board.write.service.js';
import { PlanService } from '#modules/plan/plan.service.js';
import { ProjectsService } from './projects.service.js';
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

        // Card 0149: `ProjectScopedBoardConfig` rather than `StaticBoardConfig` — see its doc comment
        // in board.config.ts. The configured project is registered eagerly, right here, so every
        // reader that runs before `start` below (or with no `runAsProject` on its call stack at all —
        // the HTTP surface, out of scope for this card) sees exactly what a single-project boot always
        // saw. `notifyWebhookUrl`/`notifyBaseUrl` are set through the setters, not `register`, because
        // they are not `runner.projects` columns (see `BoardConfig`'s own doc comment on why they are
        // not `readonly`).
        const boardConfig = new ProjectScopedBoardConfig(projectName);
        boardConfig.register({ name: projectName, boardRoot: paths.boardRoot, codeRoot: paths.codeRoot, worktreeRoot: paths.worktreeRoot, runRoot: paths.runRoot });
        // Card 0050: both optional, and off (no webhook attempted) when NOTIFY_WEBHOOK_URL is unset.
        boardConfig.notifyWebhookUrl = optionalConfigString(config, 'NOTIFY_WEBHOOK_URL');
        boardConfig.notifyBaseUrl = optionalConfigString(config, 'NOTIFY_BASE_URL');
        registry.register(BoardConfig).useInstance(boardConfig);

        // The board lives in Postgres, stage config included (`StagesModule`). `boardRoot` is still
        // resolved above only so `seedStageConfigFromBoardRepo` can carry an existing `stages.yaml`
        // over once.
        registry.register(BoardRepository).useClass(PostgresBoardRepository).asTransient();
        registry.register(BoardBootstrapService).useClass(BoardBootstrapService).asTransient();
        registry.register(BoardService).useClass(BoardService).asTransient();
        registry.register(BoardWriteService).useClass(BoardWriteService).asTransient();
        // Registered here rather than its own module: `modules.ts` is the module list, and adding a
        // one-line entry there for a single service is out of scope for card 0077 (see its plan).
        // `WorktreeModule` registers `WorktreeManager` this service depends on — order doesn't matter
        // here, `setup` only registers tokens, it does not resolve them.
        registry.register(PlanService).useClass(PlanService).asTransient();
        // Card 0149: unregistered at `setup` time for the same reason `ProjectRepository`'s own doc
        // comment gives — no container to inject a `Kysely<DB>` into yet. Registered here so `Poller`
        // and this module's own `start` hook below can inject it once the container exists; `setup`
        // only registers tokens, it does not resolve them, so the ordering is safe.
        registry.register(ProjectRepository).useClass(ProjectRepository).asSingleton();
        // Card 0162. `GET /api/projects`'s service, resolved the same way as every other operation
        // service in this module — `ProjectRepository` above is already a registered token by the
        // time anything resolves this, since `setup` only registers, it never resolves.
        registry.register(ProjectsService).useClass(ProjectsService).asTransient();
    },
    /**
     * Card 0149. Register every project already in `runner.projects`, not just the one this process's
     * own environment named — before `Jobs` starts (module order in `modules.ts`: `Board` starts
     * before `Jobs`), so a `card.stage` job pg-boss redelivers the moment its worker comes up — which
     * can happen before `Poller`'s own first tick, itself gated behind at least `POLLER_INTERVAL_MS_MIN`
     * (5s) of waiting, and not at all when the poller is disabled — never reaches `ProjectScopedBoardConfig`
     * for a project this process has not yet heard of. `Poller.tick` re-registers the same rows on
     * every tick after this, which is what picks up a project added by hand while the daemon keeps
     * running; this is only the boot-time floor under that.
     */
    start: async (container: Container) => {
        const projects = await container.get(ProjectRepository).list();
        const board = container.get(BoardConfig);
        for (const row of projects) board.register(row);
        container.get(Logger).info(`board: registered ${projects.length} project(s)`);
    },
};
