import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import type { Check, CliContext } from '@maroonedsoftware/johnny5';
import { setting } from '../settings.js';

/**
 * The test database (`db-test` in docker-compose.yml) stores its data in tmpfs, so it comes back
 * empty after every Docker restart — no schema at all, not merely stale. On 2026-09-20, after the
 * machine slept overnight, card 0257's testing stage burned three attempts and 527 failing tests
 * before a human noticed the real cause: every failure was database-backed, and `postgres reachable`
 * stayed green throughout because it only ever looks at the dev database. This check looks at the
 * test database instead, so a wiped or behind schema shows up here first.
 *
 * Never migrates anything itself — doctor reports, the operator runs the fix hint.
 */
export const testDbMigrated: Check = {
    name: 'test database migrated',
    run: async ctx => {
        const settings = testDbSettings(ctx);
        const client = new pg.Client({
            host: settings.host,
            port: Number(settings.port),
            user: settings.user,
            password: settings.password,
            database: settings.database,
        });

        try {
            await client.connect();
        } catch (err) {
            await client.end().catch(() => undefined);
            return {
                ok: false,
                message: `test database unreachable: ${(err as Error).message}`,
                fixHint: 'Start the test database (`docker compose up -d`) — it stores data in tmpfs and empties on every restart.',
            };
        }

        try {
            // Same class of bug as card 0247: a path resolved against the process's working
            // directory rather than the repo root. `wilson doctor` runs from packages/cli (the
            // root `wilson` script is `pnpm --filter @wilson/cli exec …`), so a path relative to
            // cwd never finds apps/api/data/migrations — resolve against `ctx.paths.repoRoot`
            // instead, the same anchor johnny5 uses to find apps/api/.env.
            const migrationsDir = join(ctx.paths.repoRoot, 'apps/api/data/migrations');
            let fileVersions: string[];
            try {
                fileVersions = await migrationFileVersions(migrationsDir);
            } catch (err) {
                return {
                    ok: false,
                    message: `test database migrations directory unreadable: ${migrationsDir} (${(err as Error).message})`,
                    fixHint: `Check that this is a full checkout of the repo — migrations should be at ${migrationsDir}.`,
                };
            }
            const appliedVersions = await appliedMigrationVersions(client);
            const applied = new Set(appliedVersions);
            const missing = fileVersions.filter(version => !applied.has(version));

            if (applied.size === 0) {
                return {
                    ok: false,
                    message: `test database schema is empty (0 of ${fileVersions.length} migrations applied)`,
                    fixHint: `Run: ${migrateUpCommand(settings)}`,
                };
            }

            if (missing.length > 0) {
                const named = missing.slice(0, 3).join(', ');
                const suffix = missing.length > 3 ? `, and ${missing.length - 3} more` : '';
                return {
                    ok: false,
                    message: `test database is behind: ${applied.size} of ${fileVersions.length} migrations applied, missing ${named}${suffix}`,
                    fixHint: `Run: ${migrateUpCommand(settings)}`,
                };
            }

            return { ok: true, message: `${applied.size} of ${fileVersions.length} migrations applied` };
        } finally {
            await client.end().catch(() => undefined);
        }
    },
};

interface TestDatabaseSettings {
    host: string;
    port: string;
    user: string;
    password: string;
    database: string;
}

/**
 * The five `TEST_DATABASE_*` values, read the same way `apps/api/tests/support/test.db.ts` connects
 * (card 0257), so a green check means the tests will connect too — through `setting` (card 0247),
 * never `ctx.config`, which returns nothing for every key (see settings.ts).
 */
const testDbSettings = (ctx: CliContext): TestDatabaseSettings => ({
    host: setting(ctx, 'TEST_DATABASE_HOST', 'localhost'),
    port: setting(ctx, 'TEST_DATABASE_PORT', '15533'),
    user: setting(ctx, 'TEST_DATABASE_USER', 'postgres'),
    password: setting(ctx, 'TEST_DATABASE_PASSWORD', 'postgres'),
    database: setting(ctx, 'TEST_DATABASE_NAME', 'wilson_test'),
});

/**
 * The version each `.sql` file under `dir` represents — the numeric prefix before the first
 * underscore, which is what dbmate records in `schema_migrations.version`. `dir` is the caller's
 * already-resolved absolute path; this function never guesses at the working directory itself.
 */
async function migrationFileVersions(dir: string): Promise<string[]> {
    const entries = await readdir(dir);
    return entries
        .filter(name => name.endsWith('.sql'))
        .map(name => name.split('_')[0]!)
        .sort();
}

/**
 * The versions dbmate has already recorded. A missing `schema_migrations` table — the wiped,
 * tmpfs-emptied case — reads the same as a table with zero rows: no migrations applied.
 */
async function appliedMigrationVersions(client: pg.Client): Promise<string[]> {
    try {
        const result = await client.query<{ version: string }>('select version from schema_migrations order by version');
        return result.rows.map(row => row.version);
    } catch {
        return [];
    }
}

/** The dbmate command that fixes what this check found, with the connection URL built in. */
const migrateUpCommand = (settings: TestDatabaseSettings): string =>
    `dbmate -d apps/api/data/migrations --no-dump-schema -u postgres://${settings.user}:${settings.password}@${settings.host}:${settings.port}/${settings.database} up`;
