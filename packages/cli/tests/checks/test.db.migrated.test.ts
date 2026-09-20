import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Card 0258: `postgres reachable` only ever looks at the dev database, so a wiped or unmigrated
 * *test* database (the `db-test` container stores its data in tmpfs and empties on every Docker
 * restart) stayed invisible to `wilson doctor` — the exact gap that burned three testing-stage
 * attempts and 527 failing tests on card 0257. `test.db.migrated.ts` closes that gap.
 *
 * `pg.Client` is mocked the same way `postgres.reachable.test.ts` mocks it, so these tests exercise
 * the check's own branching (unreachable vs. empty schema vs. behind vs. current) without a real
 * database. `node:fs/promises#readdir` is mocked too, so the "which migrations exist" side of the
 * comparison is under the test's control rather than depending on the repo's actual migration files.
 *
 * Card 0259: on its first real run this check threw `ENOENT` because it resolved the migrations
 * directory relative to the process's working directory, and `wilson doctor` runs from
 * `packages/cli`, not the repo root. Tests that exercise anything past the connect step now pass
 * `ctx.paths.repoRoot`, and the two tests below assert the check resolves against it — not `cwd` —
 * and fails cleanly, rather than throwing, when the resolved directory is missing.
 */
const connectMock = vi.fn();
const queryMock = vi.fn();
const endMock = vi.fn();
const clientCtor = vi.fn();
const readdirMock = vi.fn();

vi.mock('pg', () => ({
    default: {
        Client: class {
            constructor(options: unknown) {
                clientCtor(options);
            }
            connect = connectMock;
            query = queryMock;
            end = endMock;
        },
    },
}));

vi.mock('node:fs/promises', () => ({
    readdir: readdirMock,
}));

const { testDbMigrated } = await import('#src/checks/test.db.migrated.js');

describe('testDbMigrated', () => {
    beforeEach(() => {
        endMock.mockResolvedValue(undefined);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('is named "test database migrated"', () => {
        expect(testDbMigrated.name).toBe('test database migrated');
    });

    it('fails with an unreachable message and a docker-compose fix hint when it cannot connect (AC1)', async () => {
        connectMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
        const ctx = { env: {} } as never;

        const result = await testDbMigrated.run(ctx);

        expect(result).toEqual({
            ok: false,
            message: 'test database unreachable: ECONNREFUSED',
            fixHint: 'Start the test database (`docker compose up -d`) — it stores data in tmpfs and empties on every restart.',
        });
        expect(readdirMock).not.toHaveBeenCalled();
        expect(queryMock).not.toHaveBeenCalled();
    });

    it('connects using the documented TEST_DATABASE_* defaults, never ctx.config (AC5)', async () => {
        connectMock.mockRejectedValueOnce(new Error('down'));
        const ctx = { env: {} } as never;

        await testDbMigrated.run(ctx);

        expect(clientCtor).toHaveBeenCalledWith({
            host: 'localhost',
            port: 15533,
            user: 'postgres',
            password: 'postgres',
            database: 'wilson_test',
        });
    });

    it('connects using TEST_DATABASE_* from ctx.env when set, overriding the defaults (AC5)', async () => {
        connectMock.mockRejectedValueOnce(new Error('down'));
        const ctx = {
            env: {
                TEST_DATABASE_HOST: 'db-test.internal',
                TEST_DATABASE_PORT: '25533',
                TEST_DATABASE_USER: 'wilson',
                TEST_DATABASE_PASSWORD: 'secret',
                TEST_DATABASE_NAME: 'custom_test_db',
            },
        } as never;

        await testDbMigrated.run(ctx);

        expect(clientCtor).toHaveBeenCalledWith({
            host: 'db-test.internal',
            port: 25533,
            user: 'wilson',
            password: 'secret',
            database: 'custom_test_db',
        });
    });

    it('fails, reports the schema as empty, and hints the dbmate up command when connected but unmigrated (AC2)', async () => {
        connectMock.mockResolvedValueOnce(undefined);
        readdirMock.mockResolvedValueOnce(['20260823120000_card_events.sql', '20260824120000_board_tables.sql', '20260824140000_card_jobs.sql']);
        queryMock.mockRejectedValueOnce(new Error('relation "schema_migrations" does not exist'));
        const ctx = { env: {}, paths: { repoRoot: '/repo' } } as never;

        const result = await testDbMigrated.run(ctx);

        expect(result).toEqual({
            ok: false,
            message: 'test database schema is empty (0 of 3 migrations applied)',
            fixHint: 'Run: dbmate -d apps/api/data/migrations --no-dump-schema -u postgres://postgres:postgres@localhost:15533/wilson_test up',
        });
    });

    it('fails and names up to three missing versions when some migrations are missing (AC3)', async () => {
        connectMock.mockResolvedValueOnce(undefined);
        readdirMock.mockResolvedValueOnce([
            '1_a.sql',
            '2_b.sql',
            '3_c.sql',
            '4_d.sql',
            '5_e.sql',
        ]);
        queryMock.mockResolvedValueOnce({ rows: [{ version: '1' }, { version: '2' }, { version: '3' }] });
        const ctx = { env: {}, paths: { repoRoot: '/repo' } } as never;

        const result = await testDbMigrated.run(ctx);

        expect(result).toEqual({
            ok: false,
            message: 'test database is behind: 3 of 5 migrations applied, missing 4, 5',
            fixHint: 'Run: dbmate -d apps/api/data/migrations --no-dump-schema -u postgres://postgres:postgres@localhost:15533/wilson_test up',
        });
    });

    it('caps the named missing versions at three and counts the rest (AC3)', async () => {
        connectMock.mockResolvedValueOnce(undefined);
        readdirMock.mockResolvedValueOnce([
            '1_a.sql',
            '2_b.sql',
            '3_c.sql',
            '4_d.sql',
            '5_e.sql',
            '6_f.sql',
        ]);
        queryMock.mockResolvedValueOnce({ rows: [{ version: '1' }] });
        const ctx = { env: {}, paths: { repoRoot: '/repo' } } as never;

        const result = await testDbMigrated.run(ctx);

        expect(result.ok).toBe(false);
        expect(result.message).toBe('test database is behind: 1 of 6 migrations applied, missing 2, 3, 4, and 2 more');
    });

    it('passes and reports the applied count when every migration is applied (AC4)', async () => {
        connectMock.mockResolvedValueOnce(undefined);
        readdirMock.mockResolvedValueOnce(['1_a.sql', '2_b.sql']);
        queryMock.mockResolvedValueOnce({ rows: [{ version: '1' }, { version: '2' }] });
        const ctx = { env: {}, paths: { repoRoot: '/repo' } } as never;

        const result = await testDbMigrated.run(ctx);

        expect(result).toEqual({ ok: true, message: '2 of 2 migrations applied' });
    });

    it('only ever reads schema_migrations — it never issues a migration itself (AC6)', async () => {
        connectMock.mockResolvedValueOnce(undefined);
        readdirMock.mockResolvedValueOnce(['1_a.sql']);
        queryMock.mockResolvedValueOnce({ rows: [{ version: '1' }] });
        const ctx = { env: {}, paths: { repoRoot: '/repo' } } as never;

        await testDbMigrated.run(ctx);

        expect(queryMock).toHaveBeenCalledTimes(1);
        expect(queryMock).toHaveBeenCalledWith('select version from schema_migrations order by version');
    });

    it('resolves the migrations directory from ctx.paths.repoRoot, not the process working directory (card 0259 AC1)', async () => {
        // `wilson doctor` runs from packages/cli, not the repo root — chdir somewhere else
        // entirely to prove the check no longer depends on cwd for finding the migrations.
        const originalCwd = process.cwd();
        process.chdir(tmpdir());
        try {
            connectMock.mockResolvedValueOnce(undefined);
            readdirMock.mockResolvedValueOnce(['1_a.sql', '2_b.sql']);
            queryMock.mockResolvedValueOnce({ rows: [{ version: '1' }, { version: '2' }] });
            const ctx = { env: {}, paths: { repoRoot: '/some/repo/root' } } as never;

            const result = await testDbMigrated.run(ctx);

            expect(readdirMock).toHaveBeenCalledWith(join('/some/repo/root', 'apps/api/data/migrations'));
            expect(result).toEqual({ ok: true, message: '2 of 2 migrations applied' });
        } finally {
            process.chdir(originalCwd);
        }
    });

    it('fails naming the resolved path, instead of throwing, when the migrations directory is missing (card 0259 AC2)', async () => {
        connectMock.mockResolvedValueOnce(undefined);
        readdirMock.mockRejectedValueOnce(new Error('ENOENT: no such file or directory, scandir \'/some/repo/root/apps/api/data/migrations\''));
        const ctx = { env: {}, paths: { repoRoot: '/some/repo/root' } } as never;

        const result = await testDbMigrated.run(ctx);

        const resolvedPath = join('/some/repo/root', 'apps/api/data/migrations');
        expect(result).toEqual({
            ok: false,
            message: `test database migrations directory unreadable: ${resolvedPath} (ENOENT: no such file or directory, scandir '${resolvedPath}')`,
            fixHint: `Check that this is a full checkout of the repo — migrations should be at ${resolvedPath}.`,
        });
        expect(queryMock).not.toHaveBeenCalled();
    });
});
