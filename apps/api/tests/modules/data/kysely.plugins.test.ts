import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { DateTime } from 'luxon';
import { testDb } from '../../support/test.db.js';

describe('DateTimeParameterPlugin', () => {
    const db = testDb();
    const at = DateTime.fromISO('2030-01-02T03:04:05.678-05:00');

    afterAll(() => db.destroy());

    it('sends an ISO string, not a JSON-quoted one', () => {
        const { parameters } = db.selectFrom('wilson.cacheEntries').selectAll().where('expiresAt', '>', at).compile();
        expect(parameters).toEqual([at.toISO()]);
    });

    it('converts a parameter in a raw sql fragment', async () => {
        const { rows } = await sql<{ value: DateTime }>`select ${at}::timestamptz as value`.execute(db);
        expect(rows[0]!.value.toMillis()).toBe(at.toMillis());
    });

    it('round-trips single and multi-row inserts, updates and comparisons', async () => {
        const prefix = randomUUID();
        const later = at.plus({ hours: 1 });
        await db
            .insertInto('wilson.cacheEntries')
            .values({ key: `${prefix}-a`, value: '1', expiresAt: at })
            .execute();
        await db
            .insertInto('wilson.cacheEntries')
            .values([
                { key: `${prefix}-b`, value: '2', expiresAt: at },
                { key: `${prefix}-c`, value: '3', expiresAt: later },
            ])
            .execute();
        await db.updateTable('wilson.cacheEntries').set({ expiresAt: later }).where('key', '=', `${prefix}-a`).execute();

        const rows = await db
            .selectFrom('wilson.cacheEntries')
            .select(['key', 'expiresAt'])
            .where('key', 'like', `${prefix}-%`)
            .where('expiresAt', '>=', later)
            .orderBy('key')
            .execute();

        expect(rows.map(row => row.key)).toEqual([`${prefix}-a`, `${prefix}-c`]);
        expect(rows.every(row => row.expiresAt.toMillis() === later.toMillis())).toBe(true);
    });

    it('refuses an invalid DateTime', () => {
        const query = db.selectFrom('wilson.cacheEntries').selectAll().where('expiresAt', '>', DateTime.invalid('bad input'));
        expect(() => query.compile()).toThrow('invalid DateTime');
    });
});
