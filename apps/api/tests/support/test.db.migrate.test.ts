import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import setup from '#tests/support/test.db.migrate.js';
import { testDb, testDbConnection } from '#tests/support/test.db.js';
import config from '../../vitest.config.js';

/**
 * `apps/api/data/migrations`, counted the same way `test.db.migrate.ts` resolves it, so the
 * "every migration applied" assertions below track the real migrations directory instead of a
 * number hand-copied into this file that would silently drift the next time a migration lands.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('../../data/migrations', import.meta.url));
const migrationCount = readdirSync(MIGRATIONS_DIR).filter(name => name.endsWith('.sql')).length;

const ENV_KEYS = ['TEST_DATABASE_HOST', 'TEST_DATABASE_PORT', 'TEST_DATABASE_USER', 'TEST_DATABASE_PASSWORD', 'TEST_DATABASE_NAME'] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));

afterEach(() => {
    for (const key of ENV_KEYS) {
        if (originalEnv[key] === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = originalEnv[key];
        }
    }
});

const adminClient = (): pg.Client => {
    const connection = testDbConnection();
    return new pg.Client({
        host: connection.host,
        port: connection.port,
        user: connection.user,
        password: connection.password,
        database: connection.database,
    });
};

/**
 * A throwaway database on the same server as the shared `wilson_test` database, migrated and
 * dropped entirely inside the test. The suite must never drop, truncate or re-migrate the shared
 * database itself — other suites, or a merge check, may be using it at the same moment — so every
 * test below points `TEST_DATABASE_NAME` at one of these instead of at `wilson_test`.
 */
const withThrowawayDatabase = async (run: (databaseName: string) => Promise<void>): Promise<void> => {
    const admin = adminClient();
    await admin.connect();
    const databaseName = `throwaway_${randomUUID().replaceAll('-', '_')}`;
    try {
        await admin.query(`CREATE DATABASE "${databaseName}"`);
        await run(databaseName);
    } finally {
        await admin
            .query('select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()', [databaseName])
            .catch(() => undefined);
        await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
        await admin.end();
    }
};

/**
 * dbmate's own bookkeeping table isn't part of the app's schema, so it has no entry in the
 * generated `DB` type `testDb()` is typed against. Read it with a plain client instead of forcing
 * an unsafe cast through Kysely.
 */
const schemaMigrationsCount = async (databaseName: string): Promise<number> => {
    const connection = testDbConnection();
    const client = new pg.Client({ ...connection, database: databaseName });
    await client.connect();
    try {
        const result = await client.query('select 1 from schema_migrations');
        return result.rowCount ?? 0;
    } finally {
        await client.end();
    }
};

describe('test.db.migrate.ts globalSetup', () => {
    it(
        'applies every migration to an empty database, and testDb() sees exactly the database it migrated',
        async () => {
            await withThrowawayDatabase(async databaseName => {
                process.env.TEST_DATABASE_NAME = databaseName;
                await setup();

                // testDb() resolves its connection the same way setup() did (both read
                // testDbConnection()), so if it can query the freshly created runner.stage_configs
                // table on *this* throwaway database, the two were never pointed at different places.
                const db = testDb();
                try {
                    const rows = await db.selectFrom('runner.stageConfigs').selectAll().execute();
                    expect(rows).toEqual([]);
                } finally {
                    await db.destroy();
                }

                expect(await schemaMigrationsCount(databaseName)).toBe(migrationCount);
            });
        },
        30000,
    );

    it(
        'applies nothing, and logs 0 applied, the second time it runs against an already-current schema',
        async () => {
            await withThrowawayDatabase(async databaseName => {
                process.env.TEST_DATABASE_NAME = databaseName;
                await setup();
                expect(await schemaMigrationsCount(databaseName)).toBe(migrationCount);

                const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
                try {
                    await setup();
                    // Assert before mockRestore(): restoring a spy also clears its recorded calls,
                    // the same as mockReset() would.
                    expect(log).toHaveBeenCalledWith(expect.stringContaining('applied 0 migration'));
                } finally {
                    log.mockRestore();
                }

                expect(await schemaMigrationsCount(databaseName)).toBe(migrationCount);
            });
        },
        30000,
    );

    it(
        'lets two suites starting at the same moment against an empty database both succeed',
        async () => {
            await withThrowawayDatabase(async databaseName => {
                process.env.TEST_DATABASE_NAME = databaseName;

                // Both calls resolve the connection from the same TEST_DATABASE_NAME, so both
                // race for the same advisory lock; if it did not serialise them, two concurrent
                // `dbmate up` runs against an empty database would race on the same DDL and at
                // least one of these would reject. An unhandled rejection here fails the test.
                await Promise.all([setup(), setup()]);

                expect(await schemaMigrationsCount(databaseName)).toBe(migrationCount);
            });
        },
        30000,
    );

    it(
        "fails before any test starts when the database is unreachable, with dbmate's own output in the error",
        async () => {
            process.env.TEST_DATABASE_HOST = '127.0.0.1';
            // Port 1 is privileged; nothing an unprivileged test process could have bound is
            // listening there, so the connection is refused rather than merely slow.
            process.env.TEST_DATABASE_PORT = '1';
            // dbmate's own `--wait` defaults to a full minute before giving up (its README calls
            // this out by name). DBMATE_WAIT_TIMEOUT is dbmate's own documented env var for that
            // same timeout, and it reaches the child process because runDbmate spawns dbmate with
            // `{ ...process.env, DATABASE_URL }` - so this shortens dbmate's own wait to a couple
            // of seconds once it actually runs, instead of the test either waiting a minute for
            // real dbmate or mocking the spawn away. It has no effect on connectLockClient's own
            // retry budget below, which is a constant inside test.db.migrate.ts, not an env var.
            process.env.DBMATE_WAIT_TIMEOUT = '2s';

            try {
                let error: unknown;
                try {
                    await setup();
                } catch (caught) {
                    error = caught;
                }

                // The bug this replaces: a bare, un-retried lockClient.connect() threw a raw pg
                // ECONNREFUSED before dbmate was ever spawned, so dbmate's own output could never
                // end up in the error. Now that connection retries and then falls back to running
                // dbmate regardless, dbmate must actually run - and its own connection-refused
                // output, not just any mention of "connect", must be what surfaces here.
                expect(error).toBeInstanceOf(Error);
                const message = (error as Error).message;
                expect(message).toMatch(/dbmate exited/i);
                expect(message).toMatch(/connection refused|unable to connect to database/i);
            } finally {
                delete process.env.DBMATE_WAIT_TIMEOUT;
            }
        },
        // connectLockClient's own retry budget (LOCK_CONNECT_BUDGET_MS in test.db.migrate.ts) is a
        // full minute, deliberately matching dbmate's default `--wait` (AC3), and this test's
        // unreachable host/port makes every one of those retries fail immediately, so setup() does
        // not give up on the lock and fall back to (the shortened) dbmate until that whole budget
        // has elapsed. The test's own timeout has to outlast that real wait, not just dbmate's.
        70000,
    );
});

describe('apps/api vitest project wiring', () => {
    it('registers test.db.migrate.ts as the globalSetup, so it runs before any test file loads', () => {
        expect(config.test?.globalSetup).toEqual(['./tests/support/test.db.migrate.ts']);
    });
});
