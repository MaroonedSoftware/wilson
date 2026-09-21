import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { testDbConnection } from './test.db.js';

/**
 * `apps/api`'s vitest `globalSetup`: migrate the tmpfs test database (`db-test` in
 * docker-compose.yml) before any test file loads, so a container restart that wipes it costs a
 * second or two instead of a whole testing attempt (card 0273; see card 0257 for the 527 tests
 * that failed the hard way, and card 0258's doctor check, which only ever reports this).
 *
 * Spawns the repo's own dbmate against exactly the connection `testDb()` uses — both read
 * `testDbConnection()`, so they can never disagree — under a Postgres advisory lock, because two
 * card suites (or a card suite and a merge check) routinely start within seconds of each other on
 * this board, and dbmate has no lock of its own: two `up` runs against an empty database race on
 * the same DDL until one fails.
 */
export default async function setup(): Promise<void> {
    const connection = testDbConnection();
    const lockClient = await connectLockClient(connection);

    if (!lockClient) {
        // The lock connection never came up within its own short retry budget. The database may
        // still be starting after a restart, or it may genuinely be unreachable — either way, hand
        // off to dbmate rather than failing here: dbmate has its own, much longer `--wait` (a
        // minute by default), so a still-starting container is tolerated there instead of this
        // throwing a bare pg connection error before dbmate ever gets a chance to run. If no lock
        // connection could be made, nothing else holding the lock could be connected either, so
        // there is no concurrent run on this database to race against.
        const applied = await runDbmate(connection);
        console.log(`test database migrate: applied ${applied} migration(s)`);
        return;
    }

    try {
        await lockClient.query('select pg_advisory_lock($1)', [TEST_DB_MIGRATE_LOCK_KEY]);
        const applied = await runDbmate(connection);
        console.log(`test database migrate: applied ${applied} migration(s)`);
    } finally {
        await lockClient.query('select pg_advisory_unlock($1)', [TEST_DB_MIGRATE_LOCK_KEY]).catch(() => undefined);
        await lockClient.end().catch(() => undefined);
    }
}

/**
 * How many times, and how far apart, to retry the advisory-lock connection before giving up on it
 * and falling back to dbmate's own, much longer `--wait`. Short on purpose: this only needs to
 * smooth over the moment a container is mid-restart, not to duplicate dbmate's one-minute wait a
 * second time.
 */
const LOCK_CONNECT_RETRIES = 5;
const LOCK_CONNECT_RETRY_DELAY_MS = 500;

/**
 * Connect the advisory-lock client, retrying a still-starting database instead of the bare, single
 * `connect()` this used to make. That bare call threw immediately on a container restart — the
 * exact moment dbmate's own `--wait` exists to cover — so dbmate never even ran, and its output
 * could never end up in the thrown error the way a failure here is supposed to include it. Resolves
 * `undefined` if the database never accepted a connection within the retry budget, so the caller
 * can fall back to dbmate's own longer wait instead of throwing a raw pg error.
 */
async function connectLockClient(connection: ReturnType<typeof testDbConnection>): Promise<pg.Client | undefined> {
    for (let attempt = 0; attempt <= LOCK_CONNECT_RETRIES; attempt++) {
        const client = new pg.Client({
            host: connection.host,
            port: connection.port,
            user: connection.user,
            password: connection.password,
            database: connection.database,
        });
        try {
            await client.connect();
            return client;
        } catch {
            await client.end().catch(() => undefined);
            if (attempt < LOCK_CONNECT_RETRIES) {
                await sleep(LOCK_CONNECT_RETRY_DELAY_MS);
            }
        }
    }
    return undefined;
}

/**
 * Key for the advisory lock serialising dbmate runs against the test database. Arbitrary — it only
 * has to be a constant every suite agrees on, so a lock one suite takes is one another suite (or a
 * merge check running the same setup) waits on rather than racing.
 */
const TEST_DB_MIGRATE_LOCK_KEY = 273_002_57;

/** `apps/api/node_modules/.bin/dbmate` — the same binary `migrate:up` and doctor's fix hint use. */
const DBMATE_BIN = fileURLToPath(new URL('../../node_modules/.bin/dbmate', import.meta.url));

/** `apps/api/data/migrations` — resolved from this file's own location, not the process cwd. */
const MIGRATIONS_DIR = fileURLToPath(new URL('../../data/migrations', import.meta.url));

/**
 * Run dbmate's `up` against `connection`, waiting for a database still coming back up after a
 * restart, and resolve with how many migrations it applied — 0 when the schema was already
 * current, in which case dbmate does nothing and this costs well under a second.
 *
 * Never parses or applies migration files itself: dbmate owns that, `--no-dump-schema` matches the
 * `migrate:up` script, and `--wait` is dbmate's own (one minute by default).
 */
function runDbmate(connection: ReturnType<typeof testDbConnection>): Promise<number> {
    const databaseUrl = `postgres://${connection.user}:${connection.password}@${connection.host}:${connection.port}/${connection.database}?sslmode=disable`;

    return new Promise((resolve, reject) => {
        const child = spawn(DBMATE_BIN, ['-d', MIGRATIONS_DIR, '--no-dump-schema', '--wait', 'up'], {
            env: { ...process.env, DATABASE_URL: databaseUrl },
        });

        let output = '';
        child.stdout.on('data', (chunk: Buffer) => {
            output += chunk.toString();
        });
        child.stderr.on('data', (chunk: Buffer) => {
            output += chunk.toString();
        });

        child.on('error', err => {
            reject(new Error(`test database migrate: could not run dbmate at ${DBMATE_BIN}: ${err.message}`));
        });
        child.on('close', code => {
            if (code !== 0) {
                reject(new Error(`test database migrate: dbmate exited ${code}\n${output}`));
                return;
            }
            const applied = output.split('\n').filter(line => line.startsWith('Applying:')).length;
            resolve(applied);
        });
    });
}
