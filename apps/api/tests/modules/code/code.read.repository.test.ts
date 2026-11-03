import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import { CodeReadRepository } from '#modules/code/code.read.repository.js';
import type { DB } from '#modules/data/db.js';
import { testDb } from '#tests/support/test.db.js';

let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

describe('CodeReadRepository', () => {
    const rowsFor = (project: string) => db.selectFrom('wilson.codeReads').selectAll().where('project', '=', project).execute();

    it('records a read with everything that identifies it', async () => {
        const project = randomUUID();

        await new CodeReadRepository(db).record({
            project,
            operation: 'search',
            path: 'src',
            ref: 'main',
            commit: 'abc123',
            pattern: 'needle',
            subject: 'account-1',
            outcome: 'read',
        });

        expect(await rowsFor(project)).toMatchObject([
            {
                project,
                operation: 'search',
                path: 'src',
                ref: 'main',
                commitSha: 'abc123',
                pattern: 'needle',
                subject: 'account-1',
                outcome: 'read',
                reason: undefined,
            },
        ]);
    });

    it('records a refusal that never resolved a commit', async () => {
        const project = randomUUID();

        await new CodeReadRepository(db).record({
            project,
            operation: 'read',
            ref: '-Otouch',
            subject: 'account-1',
            outcome: 'refused',
            reason: 'not a plain name',
        });

        expect(await rowsFor(project)).toMatchObject([
            { path: undefined, commitSha: undefined, pattern: undefined, outcome: 'refused', reason: 'not a plain name' },
        ]);
    });

    it('records a path containing a NUL byte, which Postgres text cannot hold', async () => {
        const project = randomUUID();

        await new CodeReadRepository(db).record({
            project,
            operation: 'read',
            path: 'a\0b',
            subject: 'account-1',
            outcome: 'refused',
            reason: 'NUL',
        });

        expect(await rowsFor(project)).toMatchObject([{ path: 'a�b' }]);
    });
});
