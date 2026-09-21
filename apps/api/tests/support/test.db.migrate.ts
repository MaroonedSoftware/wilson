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
        // The lock connection never came up within LOCK_CONNECT_BUDGET_MS, which matches dbmate's
        // own default `--wait` timeout — so a database still starting after a restart (the
        // motivating scenario) has already had as long to come back as dbmate itself would allow,
        // and any concurrent suite's lock connection would have succeeded by now too if the
        // database were reachable. Reaching this point means the database is unreachable for at
        // least as long as dbmate would wait, so there is no concurrent run to race against: hand
        // off to dbmate, whose own `--wait` will fail with the same, still-unreachable database and
        // surface its output in the thrown error (AC4).
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
 * How long, and how often, to retry the advisory-lock connection before giving up on it and
 * falling back to running dbmate unlocked. This budget deliberately spans the same one minute
 * dbmate's own default `--wait` would tolerate: two suites that both start while the database is
 * still coming back up after a restart must both keep retrying the lock connection until it
 * succeeds, so they take the locked path and serialise, rather than both giving up early and
 * racing the same DDL unlocked — the exact failure the lock exists to prevent (AC3). A budget
 * shorter than dbmate's own wait would let that race happen for as long as the database takes to
 * become reachable, up to dbmate's full minute.
 */
const LOCK_CONNECT_RETRY_DELAY_MS = 500;
const LOCK_CONNECT_BUDGET_MS = 60_000;
const LOCK_CONNECT_RETRIES = Math.ceil(LOCK_CONNECT_BUDGET_MS / LOCK_CONNECT_RETRY_DELAY_MS);

/**
 * Connect the advisory-lock client, retrying a still-starting database instead of the bare, single
 * `connect()` this used to make. That bare call threw immediately on a container restart — the
 * exact moment dbmate's own `--wait` exists to cover — so dbmate never even ran, and its output
 * could never end up in the thrown error the way a failure here is supposed to include it. Resolves
 * `undefined` only once the database has stayed unreachable for the full retry budget — as long as
 * dbmate's own `--wait` would tolerate — so the caller's fallback to dbmate's own wait never runs
 * while a concurrent suite might still take the locked path.
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
