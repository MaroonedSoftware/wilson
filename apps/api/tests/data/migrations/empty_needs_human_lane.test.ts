import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, type Kysely } from 'kysely';
import { testDb, uniqueProject } from '#tests/support/test.db.js';
import type { DB } from '#modules/data/db.js';

/**
 * Exercises apps/api/data/migrations/20260824160000_empty_needs_human_lane.sql for real.
 *
 * `pnpm migrate:up` is not on this stage's allowlist, and pointing dbmate at the shared dev
 * database from a card worktree would be wrong even if it were. So this reads the migration's own
 * SQL text off disk — the same file dbmate would run — and executes it against the real test
 * database: a hand-reimplementation of "what the migration should do" would only prove the test
 * agrees with itself, the same reason postgres.board.repository.test.ts uses a real connection
 * instead of a fake.
 *
 * Every case runs inside a transaction that is always rolled back. The migration's `UPDATE` has no
 * `project` filter — it is a one-off meant to run once, table-wide — and other suites (e.g.
 * stage.dispatcher.test.ts) seed their own real `needs-human` cards against this same database.
 * Committing the update would risk flipping their rows out from under them if the suites happen to
 * run concurrently. An uncommitted write is invisible to every other connection, so rolling back
 * keeps this test from ever touching a row it didn't create.
 */
const migrationSql = readFileSync(
    new URL('../../../data/migrations/20260824160000_empty_needs_human_lane.sql', import.meta.url),
    'utf8',
);
const [, afterUp] = migrationSql.split('-- migrate:up');
if (afterUp === undefined) throw new Error('migration file has no -- migrate:up marker');
const [upSql, downSql] = afterUp.split('-- migrate:down');
if (downSql === undefined) throw new Error('migration file has no -- migrate:down marker');

let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

/** Thrown at the end of every case to force the transaction back, whether or not assertions passed. */
class Rollback extends Error {}

/** Seeds and asserts inside one transaction, then always rolls it back. */
const inRollbackTx = async (fn: (trx: Kysely<DB>) => Promise<void>): Promise<void> => {
    await expect(
        db.transaction().execute(async trx => {
            await fn(trx as unknown as Kysely<DB>);
            throw new Rollback();
        }),
    ).rejects.toThrow(Rollback);
};

const project = uniqueProject();

const insertCard = (
    trx: Kysely<DB>,
    id: string,
    stage: string,
    needsHuman: boolean,
    needsHumanReason: string | null,
): Promise<unknown> =>
    trx
        .insertInto('runner.cards')
        .values({
            project,
            id,
            title: `card ${id}`,
            stage,
            branch: null,
            body: '',
            retries: JSON.stringify({}),
            external: null,
            sourceClosed: null,
            needsHuman,
            needsHumanReason,
        })
        .execute();

const readCard = (trx: Kysely<DB>, id: string) =>
    trx.selectFrom('runner.cards').selectAll().where('project', '=', project).where('id', '=', id).executeTakeFirstOrThrow();

describe('empty_needs_human_lane migration', () => {
    it('moves a needs-human card to backlog, flagging it with the default reason', async () => {
        await inRollbackTx(async trx => {
            await insertCard(trx, '0001', 'needs-human', false, null);

            await sql.raw(upSql).execute(trx);

            const row = await readCard(trx, '0001');
            expect(row.stage).toBe('backlog');
            expect(row.needsHuman).toBe(true);
            expect(row.needsHumanReason).toBe('moved out of the retired needs-human lane');
        });
    });

    it('keeps a needs-human card carrying its own reason rather than overwriting it', async () => {
        await inRollbackTx(async trx => {
            await insertCard(trx, '0002', 'needs-human', true, 'blocked on a design call');

            await sql.raw(upSql).execute(trx);

            const row = await readCard(trx, '0002');
            expect(row.stage).toBe('backlog');
            expect(row.needsHuman).toBe(true);
            expect(row.needsHumanReason).toBe('blocked on a design call');
        });
    });

    it('leaves a card in another stage untouched, needs_human included', async () => {
        await inRollbackTx(async trx => {
            await insertCard(trx, '0003', 'implementing', false, null);

            await sql.raw(upSql).execute(trx);

            const row = await readCard(trx, '0003');
            expect(row.stage).toBe('implementing');
            expect(row.needsHuman).toBe(false);
            // A plugin on this connection maps a null jsonb-adjacent column back to `undefined`
            // rather than `null` (see postgres.board.repository.test.ts), so that is what "still
            // has no reason" looks like here.
            expect(row.needsHumanReason).toBeUndefined();
        });
    });

    it('down half is a no-op that succeeds and changes nothing', async () => {
        await inRollbackTx(async trx => {
            await insertCard(trx, '0004', 'backlog', true, 'moved out of the retired needs-human lane');

            await sql.raw(downSql).execute(trx);

            const row = await readCard(trx, '0004');
            expect(row.stage).toBe('backlog');
            expect(row.needsHuman).toBe(true);
            expect(row.needsHumanReason).toBe('moved out of the retired needs-human lane');
        });
    });
});
