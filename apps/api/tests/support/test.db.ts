import { randomUUID } from 'node:crypto';
import { Kysely, PostgresDialect } from 'kysely';
import { KyselyDefaultPlugins, KyselyPgTypeOverrides, KyselyPool } from '@maroonedsoftware/kysely';
import type { DB } from '#modules/data/db.js';

/**
 * A connection to the tmpfs test database (`db-test` in docker-compose.yml).
 *
 * Tests that touch the board need a real one: the board is Postgres now, and a fake would only prove
 * the test agrees with itself about what a write means — the same reason these tests used a real git
 * repo before. Run `pnpm --filter @wilson/api exec dbmate ... up` against it once; the schema then
 * persists for as long as the container does.
 */
export const testDb = (): Kysely<DB> =>
    new Kysely<DB>({
        dialect: new PostgresDialect({
            pool: new KyselyPool({
                host: process.env.TEST_DATABASE_HOST ?? 'localhost',
                port: Number(process.env.TEST_DATABASE_PORT ?? 15533),
                user: process.env.TEST_DATABASE_USER ?? 'postgres',
                password: process.env.TEST_DATABASE_PASSWORD ?? 'postgres',
                database: process.env.TEST_DATABASE_NAME ?? 'wilson_test',
                types: KyselyPgTypeOverrides,
            }),
        }),
        plugins: [...KyselyDefaultPlugins],
    });

/**
 * A project name no other test uses.
 *
 * Cards are keyed by `(project, id)`, so a unique project is all the isolation a test needs — no
 * schema per test, no truncation between them, and tests in the same file can run against one
 * connection. This is the cheap version of what card 0027 wants for worktrees.
 *
 * This used to append a module-level counter to `process.pid`: pid to separate workers, the
 * counter to separate calls within one. That reasoning was sound and the implementation still
 * broke, because vitest gives each test file its own module registry — the counter restarts at 0
 * in every file, not once per worker. Two DB-touching files running in the same worker both
 * produced `test-<pid>-0`, their cards collided on `(project, id)`, and whichever inserted second
 * failed, intermittently, depending on scheduling. Anything reset per file reintroduces the same
 * bug in a new shape, so the fix cannot be more module state.
 *
 * `randomUUID()` has no module state to reset: it pulls fresh cryptographic randomness from the OS
 * on every call, so two calls collide only by a 128-bit-random accident — unlike `Math.random()`,
 * which is unseeded and only improbable, not cryptographically random. That holds regardless of
 * which files vitest loads into which worker or in what order. The `pid` prefix is no longer load
 * bearing for uniqueness; it stays so a failing project name is traceable back to its worker.
 */
export const uniqueProject = (): string => `test-${process.pid}-${randomUUID()}`;

/**
 * Give `project` a stage config — the row `PostgresStageConfigStore.load` reads — in place of the
 * `config/stages.yaml` a test used to write under a temp `boardRoot`. For a suite that already talks
 * to the test database; one that only needs a parsed config can construct `StaticStageConfigStore`
 * (`#modules/stages/stage.config.store.js`) with the same string and skip the row.
 */
export const seedStageConfig = async (db: Kysely<DB>, project: string, yaml: string, message = 'test'): Promise<void> => {
    await db.insertInto('runner.stageConfigs').values({ project, yaml, message }).execute();
};
