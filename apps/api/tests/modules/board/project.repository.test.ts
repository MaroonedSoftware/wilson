import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import type { DB } from '#modules/data/db.js';
import { ProjectRepository, type ProjectRow } from '#modules/board/project.repository.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';

/**
 * Card 0148. `ProjectRepository` is the new `runner.projects` table's only reader/writer —
 * `BoardModule.setup` is its one real caller, but that caller is exercised through a full boot in
 * `board.module.test.ts`. These tests go straight at the repository, against a real connection
 * (the same reasoning `postgres.board.repository.test.ts` gives for the board itself: a fake would
 * only prove the test agrees with itself about what a write means).
 */
let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

const row = (name: string, overrides: Partial<Omit<ProjectRow, 'name'>> = {}): ProjectRow => ({
    name,
    boardRoot: '/tmp/board',
    codeRoot: '/tmp/code',
    worktreeRoot: '/tmp/wt',
    runRoot: '/tmp/run',
    ...overrides,
});

describe('ProjectRepository', () => {
    it('reports no row for a project that has never been created', async () => {
        const repo = new ProjectRepository(db);

        expect(await repo.find(uniqueProject())).toBeUndefined();
    });

    it('reads back exactly what it created, name and every path included', async () => {
        const repo = new ProjectRepository(db);
        const name = uniqueProject();
        const created = row(name, { boardRoot: '/tmp/board-x', codeRoot: '/tmp/code-x', worktreeRoot: '/tmp/wt-x', runRoot: '/tmp/run-x' });

        await repo.create(created);

        expect(await repo.find(name)).toEqual(created);
    });

    /**
     * `name` is `runner.projects`' primary key, deliberately — the plan calls it "the same value
     * every other table's `project` column already holds", so two rows for one name would be two
     * disagreeing identities for the same project. `BoardModule.setup`'s "find, else create" only
     * avoids that race in the common case; the constraint is what makes a genuine collision fail
     * loudly instead of silently overwriting the first row's paths.
     */
    it('refuses to create a second row for a name that already exists, leaving the first untouched', async () => {
        const repo = new ProjectRepository(db);
        const name = uniqueProject();
        await repo.create(row(name, { boardRoot: '/tmp/original-board' }));

        await expect(repo.create(row(name, { boardRoot: '/tmp/impostor-board' }))).rejects.toThrow();

        expect((await repo.find(name))?.boardRoot).toBe('/tmp/original-board');
    });

    /**
     * Card 0149. `list` is this card's one addition to `ProjectRepository` — the poller's own doc
     * comment (`poller.ts`) says why: a tick needs the full set of registered projects to walk, not
     * just one name it already knows to `find`.
     */
    describe('list (card 0149)', () => {
        it('includes a project name-ascending among rows list already returned, once created', async () => {
            const repo = new ProjectRepository(db);
            // Prefixed so both names sort adjacently regardless of what other tests have created —
            // uniqueProject()'s own uniqueness (see test.db.js) is enough to isolate the pair from
            // every other row in the table without needing to assert on the whole result set.
            const base = uniqueProject();
            const first = `${base}-a`;
            const second = `${base}-b`;
            await repo.create(row(second, { boardRoot: '/tmp/second-board' }));
            await repo.create(row(first, { boardRoot: '/tmp/first-board' }));

            const rows = await repo.list();
            const names = rows.map(r => r.name);
            const firstIndex = names.indexOf(first);
            const secondIndex = names.indexOf(second);

            expect(firstIndex).toBeGreaterThanOrEqual(0);
            expect(secondIndex).toBeGreaterThanOrEqual(0);
            // Name ascending: the alphabetically earlier name (`-a`) must come before `-b`, even
            // though it was the second one created.
            expect(firstIndex).toBeLessThan(secondIndex);
            expect(rows.find(r => r.name === first)).toEqual(row(first, { boardRoot: '/tmp/first-board' }));
            expect(rows.find(r => r.name === second)).toEqual(row(second, { boardRoot: '/tmp/second-board' }));
        });

        it('reflects a project created after an earlier list() call, without needing a fresh repository instance', async () => {
            const repo = new ProjectRepository(db);
            const name = uniqueProject();

            const before = await repo.list();
            expect(before.some(r => r.name === name)).toBe(false);

            await repo.create(row(name));

            const after = await repo.list();
            expect(after.some(r => r.name === name)).toBe(true);
        });
    });
});
