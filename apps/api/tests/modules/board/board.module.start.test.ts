import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppConfig } from '@maroonedsoftware/appconfig';
import { ConsoleLogger } from '@maroonedsoftware/logger';
import { ServerKitServerBuilder } from '@maroonedsoftware/koa';
import type { Container } from 'injectkit';
import type { Kysely } from 'kysely';
import type { DB } from '#modules/data/db.js';
import { BoardConfig } from '#modules/board/board.config.js';
import { BoardModule } from '#modules/board/board.module.js';
import { runAsProject } from '#modules/board/project.context.js';
import { buildConfig, modules } from '#src/cli-bootstrap.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';

/**
 * Card 0149. `BoardModule.start` — new this card — registers every row already sitting in
 * `runner.projects` onto the live `BoardConfig`, not just the one project this process's own
 * environment named at `setup`. These boot the app's own module list against a real database, the
 * same way `board.module.test.ts` does for `setup`, because the whole point is what `start` does
 * against Postgres: a project inserted "by hand" (`runner.projects` has no HTTP writer yet, per the
 * plan's Out of scope) between `setup` and `start` must still be reachable once `start` has run.
 */
let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

const uniquePaths = async (): Promise<{ codeRoot: string; worktreeRoot: string; runRoot: string }> => {
    const base = await mkdtemp(join(tmpdir(), 'wilson-0149-'));
    const codeRoot = resolve(base, 'code');
    return {
        codeRoot,
        worktreeRoot: resolve(codeRoot, '../.worktrees'),
        runRoot: resolve(codeRoot, '../.run'),
    };
};

const projectConfig = async (name: string, paths: { codeRoot: string }): Promise<AppConfig> => {
    const dir = await mkdtemp(join(tmpdir(), 'wilson-0149-config-'));
    const envFile = join(dir, '.env');
    await writeFile(
        envFile,
        [
            `DATABASE_HOST=${process.env.TEST_DATABASE_HOST ?? 'localhost'}`,
            `DATABASE_PORT=${process.env.TEST_DATABASE_PORT ?? 15533}`,
            `DATABASE_USER=${process.env.TEST_DATABASE_USER ?? 'postgres'}`,
            `DATABASE_PASSWORD=${process.env.TEST_DATABASE_PASSWORD ?? 'postgres'}`,
            `DATABASE_NAME=${process.env.TEST_DATABASE_NAME ?? 'wilson_test'}`,
            `PROJECT_NAME=${name}`,
            `PROJECT_CODE_ROOT=${paths.codeRoot}`,
        ].join('\n'),
        'utf8',
    );
    return buildConfig({ envFile });
};

/**
 * Boots the app's own module list through `setup` only (`ServerKitServerBuilder.setup`), returning
 * the container — the same helper `board.module.test.ts` uses. `setup` never calls any module's
 * `start` hook (that only happens inside `ServerKitServerBuilder.start`, once a real server is
 * listening), so calling `BoardModule.start` directly against this container, below, is what actually
 * exercises the behaviour this card adds — not a side effect of some other module boot.
 */
const bootContainer = async (config: AppConfig): Promise<Container> => new ServerKitServerBuilder().setup(config, new ConsoleLogger(), modules);

describe('BoardModule.start (card 0149)', () => {
    it('registers the boot-configured project itself, so it answers even before start() adds anything else', async () => {
        const name = uniqueProject();
        const paths = await uniquePaths();
        const container = await bootContainer(await projectConfig(name, paths));
        const boardConfig = container.get(BoardConfig);

        await BoardModule.start!(container);

        expect(boardConfig.project).toBe(name);
        expect(boardConfig.codeRoot).toBe(paths.codeRoot);
    });

    /**
     * The acceptance criterion this pins down: "With two registered projects... each stage runs
     * against its own project's codeRoot and worktreeRoot." A second project registered by hand
     * (an `insertInto('runner.projects')`, standing in for the manual row-insertion the plan's Out of
     * scope describes) between `setup` and `start` must be reachable through `boardConfig` once
     * `start` has run — this is the boot-time floor `Poller.tick`'s own re-registration builds on,
     * per `BoardModule.start`'s doc comment.
     */
    it('registers a second project inserted by hand before start(), so BoardConfig can answer for it too', async () => {
        const bootedName = uniqueProject();
        const bootedPaths = await uniquePaths();
        const container = await bootContainer(await projectConfig(bootedName, bootedPaths));
        const boardConfig = container.get(BoardConfig);

        const handInsertedName = uniqueProject();
        const handInsertedPaths = await uniquePaths();
        await db
            .insertInto('runner.projects')
            .values({
                name: handInsertedName,
                codeRoot: handInsertedPaths.codeRoot,
                worktreeRoot: handInsertedPaths.worktreeRoot,
                runRoot: handInsertedPaths.runRoot,
            })
            .execute();

        // Before start(): the hand-inserted project was never registered on this BoardConfig
        // instance, so reading it throws rather than silently answering with the booted project's
        // paths (ProjectScopedBoardConfig's own contract — see project.scoped.board.config.test.ts).
        await expect(runAsProject(handInsertedName, async () => boardConfig.codeRoot)).rejects.toThrow();

        await BoardModule.start!(container);

        await runAsProject(handInsertedName, async () => {
            expect(boardConfig.codeRoot).toBe(handInsertedPaths.codeRoot);
            expect(boardConfig.worktreeRoot).toBe(handInsertedPaths.worktreeRoot);
            expect(boardConfig.runRoot).toBe(handInsertedPaths.runRoot);
        });
        // The originally booted project must still resolve correctly too — start() must not
        // disturb what setup() already registered for it.
        expect(boardConfig.project).toBe(bootedName);
        expect(boardConfig.codeRoot).toBe(bootedPaths.codeRoot);
    });

    it('keeps two registered projects from colliding on disk: each stays under its own registered paths', async () => {
        const nameA = uniqueProject();
        const pathsA = await uniquePaths();
        const container = await bootContainer(await projectConfig(nameA, pathsA));
        const boardConfig = container.get(BoardConfig);

        const nameB = uniqueProject();
        const pathsB = await uniquePaths();
        await db
            .insertInto('runner.projects')
            .values({ name: nameB, codeRoot: pathsB.codeRoot, worktreeRoot: pathsB.worktreeRoot, runRoot: pathsB.runRoot })
            .execute();

        await BoardModule.start!(container);

        const seenWorktreeRoots = new Set<string>();
        await runAsProject(nameA, async () => seenWorktreeRoots.add(boardConfig.worktreeRoot));
        await runAsProject(nameB, async () => seenWorktreeRoots.add(boardConfig.worktreeRoot));

        expect(seenWorktreeRoots.size).toBe(2);
        expect(seenWorktreeRoots.has(pathsA.worktreeRoot)).toBe(true);
        expect(seenWorktreeRoots.has(pathsB.worktreeRoot)).toBe(true);
    });
});
