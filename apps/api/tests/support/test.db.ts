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

let counter = 0;

/**
 * A project name no other test uses.
 *
 * Cards are keyed by `(project, id)`, so a unique project is all the isolation a test needs — no
 * schema per test, no truncation between them, and tests in the same file can run against one
 * connection. This is the cheap version of what card 0027 wants for worktrees.
 */
export const uniqueProject = (): string => `test-${process.pid}-${counter++}`;
