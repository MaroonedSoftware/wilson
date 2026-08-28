import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppConfig } from '@maroonedsoftware/appconfig';
import { ConsoleLogger } from '@maroonedsoftware/logger';
import { ServerKitServerBuilder } from '@maroonedsoftware/koa';
import type { Kysely } from 'kysely';
import type { DB } from '#modules/data/db.js';
import { BoardConfig } from '#modules/board/board.config.js';
import { buildConfig, modules } from '#src/cli-bootstrap.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';

/**
 * Card 0148. Before this card, `BoardModule.setup` assembled `BoardConfig` fresh from
 * `PROJECT_CODE_ROOT`/`PROJECT_BOARD_ROOT`/friends on every boot — nothing else. Now it reads (or,
 * the first time, creates) a `runner.projects` row and boots `BoardConfig` from that row instead,
 * with the row winning outright once it exists. These tests boot the app's own module list against
 * a real database, the same way `container.setup.test.ts` does, because the whole point is what
 * `BoardModule.setup` does against Postgres — a fake repository would only prove the test agrees
 * with itself about what "first boot" and "second boot" mean.
 */
let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

/**
 * A fresh pair of paths under their own temp directory, so a project's default `worktreeRoot`/
 * `runRoot` (derived from `codeRoot`, unchanged by this card) differ between two calls the same way
 * two different checkouts would — letting a test tell "the row's paths" apart from "whatever the
 * environment says right now" on every field, not just `codeRoot`/`boardRoot`.
 */
const uniquePaths = async (): Promise<{ codeRoot: string; boardRoot: string; worktreeRoot: string; runRoot: string }> => {
    const base = await mkdtemp(join(tmpdir(), 'wilson-0148-'));
    const codeRoot = resolve(base, 'code');
    return {
        codeRoot,
        boardRoot: resolve(base, 'board'),
        worktreeRoot: resolve(codeRoot, '../.worktrees'),
        runRoot: resolve(codeRoot, '../.run'),
    };
};

/**
 * A config built the way the real daemon reads its `.env` (`buildConfig`, `cli-bootstrap.ts`),
 * rather than by mutating `process.env` — see `buildTestServerConfig`'s comment for why a real file
 * is required: neither `AppConfigSourceDotenv` nor `AppConfigResolverEnv` reads `process.env`
 * directly.
 */
const projectConfig = async (name: string, paths: { codeRoot: string; boardRoot: string }): Promise<AppConfig> => {
    const dir = await mkdtemp(join(tmpdir(), 'wilson-0148-config-'));
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
            `PROJECT_BOARD_ROOT=${paths.boardRoot}`,
        ].join('\n'),
        'utf8',
    );
    return buildConfig({ envFile });
};

/**
 * Boots the app's own module list (`cli-bootstrap.ts`'s `modules`) against `config` and returns the
 * `BoardConfig` it registered — the same call the server and the CLI both make, per
 * `container.setup.test.ts`.
 */
const bootBoardConfig = async (config: AppConfig): Promise<BoardConfig> => {
    const container = await new ServerKitServerBuilder().setup(config, new ConsoleLogger(), modules);
    return container.get(BoardConfig);
};

describe('BoardModule (card 0148)', () => {
    it('creates a runner.projects row from the environment on a first boot, and boots BoardConfig from it', async () => {
        const name = uniqueProject();
        const paths = await uniquePaths();

        const boardConfig = await bootBoardConfig(await projectConfig(name, paths));

        expect(boardConfig.project).toBe(name);
        expect(boardConfig.codeRoot).toBe(paths.codeRoot);
        expect(boardConfig.boardRoot).toBe(paths.boardRoot);
        expect(boardConfig.worktreeRoot).toBe(paths.worktreeRoot);
        expect(boardConfig.runRoot).toBe(paths.runRoot);

        const row = await db.selectFrom('runner.projects').selectAll().where('name', '=', name).executeTakeFirst();
        expect(row?.boardRoot).toBe(paths.boardRoot);
        expect(row?.codeRoot).toBe(paths.codeRoot);
        expect(row?.worktreeRoot).toBe(paths.worktreeRoot);
        expect(row?.runRoot).toBe(paths.runRoot);
    });

    it('does not create a second row for the same project on a second, identical boot', async () => {
        const name = uniqueProject();
        const config = await projectConfig(name, await uniquePaths());

        await bootBoardConfig(config);
        await bootBoardConfig(config);

        const rows = await db.selectFrom('runner.projects').selectAll().where('name', '=', name).execute();
        expect(rows).toHaveLength(1);
    });

    /**
     * The disagreement the migration's header comment documents: once a row exists it wins outright,
     * with no comparison against and no merge with whatever the environment says on a later boot.
     */
    it('reads the existing row on a second boot, ignoring environment values that now disagree with it', async () => {
        const name = uniqueProject();
        const firstPaths = await uniquePaths();
        await bootBoardConfig(await projectConfig(name, firstPaths));

        // A later boot for the same project, from a shell whose environment now names different
        // paths entirely — a stale checkout, or one that moved.
        const secondPaths = await uniquePaths();
        const boardConfig = await bootBoardConfig(await projectConfig(name, secondPaths));

        expect(boardConfig.codeRoot).toBe(firstPaths.codeRoot);
        expect(boardConfig.boardRoot).toBe(firstPaths.boardRoot);
        expect(boardConfig.worktreeRoot).toBe(firstPaths.worktreeRoot);
        expect(boardConfig.runRoot).toBe(firstPaths.runRoot);
        expect(boardConfig.codeRoot).not.toBe(secondPaths.codeRoot);

        const rows = await db.selectFrom('runner.projects').selectAll().where('name', '=', name).execute();
        expect(rows).toHaveLength(1);
    });

    it("does not overwrite a value an operator changed by hand, even when the environment still matches the original", async () => {
        const name = uniqueProject();
        const config = await projectConfig(name, await uniquePaths());
        await bootBoardConfig(config);

        const editedBoardRoot = '/tmp/wilson-0148/operator-edited-board';
        await db.updateTable('runner.projects').set({ boardRoot: editedBoardRoot }).where('name', '=', name).execute();

        // Same config as the first boot — an operator who edited the row and restarted with the
        // very environment that first created it still gets the edited row back, not a value the
        // environment happens to agree with.
        const boardConfig = await bootBoardConfig(config);

        expect(boardConfig.boardRoot).toBe(editedBoardRoot);
    });
});
