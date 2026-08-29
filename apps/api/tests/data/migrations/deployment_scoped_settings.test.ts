import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, type Kysely } from 'kysely';
import { testDb, uniqueProject } from '#tests/support/test.db.js';
import type { DB } from '#modules/data/db.js';

/**
 * Exercises apps/api/data/migrations/20260829120000_deployment_scoped_settings.sql for real, the
 * same way empty_needs_human_lane.test.ts exercises its own migration: read the SQL dbmate would
 * run off disk and run it against the real test database, rather than reimplementing "what the
 * migration should do" in TypeScript and only proving the test agrees with itself.
 *
 * `runner.settings` is keyed `(project, key)` with no foreign key to `runner.projects`, so an
 * arbitrary `uniqueProject()` string is exactly as valid a row owner here as a real one. Every case
 * runs inside a transaction that is always rolled back — this migration's `UPDATE`/`DELETE` have no
 * per-row scoping an uncommitted test could add, so committing would risk touching a row another
 * suite (or another case in this file) owns.
 */
const migrationSql = readFileSync(
    new URL('../../../data/migrations/20260829120000_deployment_scoped_settings.sql', import.meta.url),
    'utf8',
);
const [, afterUp] = migrationSql.split('-- migrate:up');
if (afterUp === undefined) throw new Error('migration file has no -- migrate:up marker');
const [upSql, downSql] = afterUp.split('-- migrate:down');
if (downSql === undefined) throw new Error('migration file has no -- migrate:down marker');

const DEPLOYMENT_SCOPE = '__deployment__';

let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

class Rollback extends Error {}

const inRollbackTx = async (fn: (trx: Kysely<DB>) => Promise<void>): Promise<void> => {
    await expect(
        db.transaction().execute(async trx => {
            await fn(trx as unknown as Kysely<DB>);
            throw new Rollback();
        }),
    ).rejects.toThrow(Rollback);
};

const insertSetting = (trx: Kysely<DB>, project: string, key: string, value: unknown, updatedAt: string): Promise<unknown> =>
    trx
        .insertInto('runner.settings')
        .values({ project, key, value: JSON.stringify(value), updatedAt })
        .execute();

const rowsForKey = (trx: Kysely<DB>, key: string) =>
    trx.selectFrom('runner.settings').selectAll().where('key', '=', key).execute();

describe('deployment_scoped_settings migration', () => {
    it('moves an existing claude-config-dir row onto the reserved deployment project', async () => {
        await inRollbackTx(async trx => {
            const project = uniqueProject();
            await insertSetting(trx, project, 'claude-config-dir', '/home/op/.claude', '2026-08-01T00:00:00Z');

            await sql.raw(upSql).execute(trx);

            const rows = await rowsForKey(trx, 'claude-config-dir');
            expect(rows).toHaveLength(1);
            expect(rows[0]?.project).toBe(DEPLOYMENT_SCOPE);
            expect(rows[0]?.value).toBe('/home/op/.claude');
        });
    });

    it('moves an existing card-stage-concurrency row onto the reserved deployment project', async () => {
        await inRollbackTx(async trx => {
            const project = uniqueProject();
            await insertSetting(trx, project, 'card-stage-concurrency', 5, '2026-08-01T00:00:00Z');

            await sql.raw(upSql).execute(trx);

            const rows = await rowsForKey(trx, 'card-stage-concurrency');
            expect(rows).toHaveLength(1);
            expect(rows[0]?.project).toBe(DEPLOYMENT_SCOPE);
            expect(rows[0]?.value).toBe(5);
        });
    });

    it('leaves a project-scoped setting untouched under its own project', async () => {
        await inRollbackTx(async trx => {
            const project = uniqueProject();
            await insertSetting(trx, project, 'poller-enabled', true, '2026-08-01T00:00:00Z');

            await sql.raw(upSql).execute(trx);

            const rows = await rowsForKey(trx, 'poller-enabled');
            const row = rows.find(r => r.project === project);
            expect(row).toBeDefined();
            expect(row?.value).toBe(true);
            expect(rows.some(r => r.project === DEPLOYMENT_SCOPE)).toBe(false);
        });
    });

    /**
     * The migration's own header comment: a second project having also written one of these two keys
     * is not possible yet, but the migration does not assume that away — if it finds more than one
     * row for the same key, it keeps only the most recently updated one, "last write wins" the same
     * as a single `SettingsStore.set` already gives one row.
     */
    it('keeps only the most recently updated row when more than one project has written the same key', async () => {
        await inRollbackTx(async trx => {
            const older = uniqueProject();
            const newer = uniqueProject();
            await insertSetting(trx, older, 'card-stage-concurrency', 2, '2026-08-01T00:00:00Z');
            await insertSetting(trx, newer, 'card-stage-concurrency', 8, '2026-08-15T00:00:00Z');

            await sql.raw(upSql).execute(trx);

            const rows = await rowsForKey(trx, 'card-stage-concurrency');
            expect(rows).toHaveLength(1);
            expect(rows[0]?.project).toBe(DEPLOYMENT_SCOPE);
            expect(rows[0]?.value).toBe(8);
        });
    });

    it('down half is a no-op that succeeds and changes nothing', async () => {
        await inRollbackTx(async trx => {
            await insertSetting(trx, DEPLOYMENT_SCOPE, 'claude-config-dir', '/home/op/.claude', '2026-08-01T00:00:00Z');

            await sql.raw(downSql).execute(trx);

            const rows = await rowsForKey(trx, 'claude-config-dir');
            expect(rows).toHaveLength(1);
            expect(rows[0]?.project).toBe(DEPLOYMENT_SCOPE);
            expect(rows[0]?.value).toBe('/home/op/.claude');
        });
    });
});
