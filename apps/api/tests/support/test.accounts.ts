import pg from 'pg';
import type { Kysely } from 'kysely';
import type { DB } from '#modules/data/db.js';
import { testDbConnection } from './test.db.js';

/**
 * Key for the advisory lock that gives one test file `runner.accounts` to itself. Arbitrary, like
 * `test.db.migrate.ts`'s, as long as every suite agrees on it.
 */
const TEST_ACCOUNTS_LOCK_KEY = 273_002_58;

/**
 * Hold `runner.accounts` for the life of a test file.
 *
 * Every other table's tests isolate by a unique project (`uniqueProject`), but `accounts_one_row`
 * admits a single account for the whole database, so two files creating one at once would see
 * each other's. vitest runs files in parallel, so each file that writes accounts takes this
 * session-level lock in `beforeAll`, on a connection of its own, and the next file waits for it.
 *
 * Returns the release, for `afterAll`. Call {@link clearAccounts} wherever a test needs to start
 * from a database with no account in it.
 */
export const holdAccounts = async (): Promise<() => Promise<void>> => {
    const client = new pg.Client(testDbConnection());
    await client.connect();
    await client.query('select pg_advisory_lock($1)', [TEST_ACCOUNTS_LOCK_KEY]);
    return async () => {
        await client.query('select pg_advisory_unlock($1)', [TEST_ACCOUNTS_LOCK_KEY]).catch(() => undefined);
        await client.end().catch(() => undefined);
    };
};

/** Delete every account, its password, API keys and second factors, so onboarding can run again. Only under
 * {@link holdAccounts}. */
export const clearAccounts = async (db: Kysely<DB>): Promise<void> => {
    await db.deleteFrom('runner.apiKeys').execute();
    await db.deleteFrom('runner.accountAuthenticators').execute();
    await db.deleteFrom('runner.accountPasskeys').execute();
    await db.deleteFrom('runner.accountPasswords').execute();
    await db.deleteFrom('runner.accounts').execute();
};
