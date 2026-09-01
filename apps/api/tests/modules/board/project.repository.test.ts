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
        const created = row(name, { codeRoot: '/tmp/code-x', worktreeRoot: '/tmp/wt-x', runRoot: '/tmp/run-x' });

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
        await repo.create(row(name, { codeRoot: '/tmp/original-code' }));

        await expect(repo.create(row(name, { codeRoot: '/tmp/impostor-code' }))).rejects.toThrow();

        expect((await repo.find(name))?.codeRoot).toBe('/tmp/original-code');
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
            await repo.create(row(second, { codeRoot: '/tmp/second-code' }));
            await repo.create(row(first, { codeRoot: '/tmp/first-code' }));

            const rows = await repo.list();
            const names = rows.map(r => r.name);
            const firstIndex = names.indexOf(first);
            const secondIndex = names.indexOf(second);

            expect(firstIndex).toBeGreaterThanOrEqual(0);
            expect(secondIndex).toBeGreaterThanOrEqual(0);
            // Name ascending: the alphabetically earlier name (`-a`) must come before `-b`, even
            // though it was the second one created.
            expect(firstIndex).toBeLessThan(secondIndex);
            expect(rows.find(r => r.name === first)).toEqual(row(first, { codeRoot: '/tmp/first-code' }));
            expect(rows.find(r => r.name === second)).toEqual(row(second, { codeRoot: '/tmp/second-code' }));
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

    /**
     * Card 0168. `update`'s one caller is `ProjectsService.update`, which validates paths before
     * calling this — these tests go straight at the repository, the same way `create`'s own tests
     * above do, against a real connection rather than a fake.
     */
    describe('update (card 0168)', () => {
        it('sets only the named columns, leaving every other path column exactly as it was', async () => {
            const repo = new ProjectRepository(db);
            const name = uniqueProject();
            await repo.create(row(name));

            const matched = await repo.update(name, { codeRoot: '/tmp/code-corrected' });

            expect(matched).toBe(true);
            expect(await repo.find(name)).toEqual(row(name, { codeRoot: '/tmp/code-corrected' }));
        });

        it('sets every named column when the patch carries more than one', async () => {
            const repo = new ProjectRepository(db);
            const name = uniqueProject();
            await repo.create(row(name));

            const matched = await repo.update(name, { worktreeRoot: '/tmp/wt-corrected', runRoot: '/tmp/run-corrected' });

            expect(matched).toBe(true);
            expect(await repo.find(name)).toEqual(row(name, { worktreeRoot: '/tmp/wt-corrected', runRoot: '/tmp/run-corrected' }));
        });

        it('reports no match, and writes nothing, for a name that was never created', async () => {
            const repo = new ProjectRepository(db);
            const name = uniqueProject();

            const matched = await repo.update(name, { codeRoot: '/tmp/ghost-code' });

            expect(matched).toBe(false);
            expect(await repo.find(name)).toBeUndefined();
        });

        it('does not touch another project\'s row with the same patch', async () => {
            const repo = new ProjectRepository(db);
            const base = uniqueProject();
            const target = `${base}-target`;
            const bystander = `${base}-bystander`;
            await repo.create(row(target));
            await repo.create(row(bystander));

            await repo.update(target, { codeRoot: '/tmp/target-only' });

            expect((await repo.find(target))?.codeRoot).toBe('/tmp/target-only');
            expect((await repo.find(bystander))?.codeRoot).toBe('/tmp/code');
        });

        /**
         * `PATCH /api/projects/{name}` with every field absent is a valid request under the
         * contract's own semantics (every `UpdateProjectRequest` field is optional), so `update`
         * must accept an empty patch rather than reaching Kysely's `set()` with nothing in it —
         * `set({})` compiles to `update "runner"."projects" set  where "name" = $1`, a SET clause
         * with no assignments, which Postgres rejects with a syntax error rather than treating as a
         * no-op. This goes at the repository directly, against the real connection, because a fake
         * would only prove the test agrees with itself about what an empty `set()` does — the whole
         * bug was Postgres disagreeing.
         */
        it('reports a match and writes nothing for an empty patch against a project that exists, without throwing', async () => {
            const repo = new ProjectRepository(db);
            const name = uniqueProject();
            const created = row(name);
            await repo.create(created);

            const matched = await repo.update(name, {});

            expect(matched).toBe(true);
            expect(await repo.find(name)).toEqual(created);
        });

        it('reports no match for an empty patch against a name that was never created, without throwing', async () => {
            const repo = new ProjectRepository(db);
            const name = uniqueProject();

            const matched = await repo.update(name, {});

            expect(matched).toBe(false);
        });
    });
});
