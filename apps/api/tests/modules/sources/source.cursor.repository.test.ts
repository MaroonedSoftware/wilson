import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { SourceCursorRepository } from '#modules/sources/source.cursor.repository.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';
import type { DB } from '#modules/data/db.js';

let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

const freshRepo = (project = uniqueProject()): { project: string; repo: SourceCursorRepository } => {
    const config = new StaticBoardConfig(project, '/tmp/code', '/tmp/wt', '/tmp/run');
    return { project, repo: new SourceCursorRepository(config, db) };
};

/**
 * Card 0198, task 1. Against a real database (`runner.source_cursors`, the migration card 0192's
 * process leaves to the operator) — the same idiom `settings.store.test.ts` uses for
 * `runner.settings`.
 */
describe('SourceCursorRepository', () => {
    it('reports undefined for a source with no row yet — "since the beginning"', async () => {
        const { repo } = freshRepo();

        expect(await repo.get('linear')).toBeUndefined();
    });

    it('reads back exactly what was set', async () => {
        const { repo } = freshRepo();

        await repo.set('linear', 'cursor-1');

        expect(await repo.get('linear')).toBe('cursor-1');
    });

    it('upserts rather than accumulating a row per write, and reads the latest value', async () => {
        const { project, repo } = freshRepo();

        await repo.set('linear', 'cursor-1');
        await repo.set('linear', 'cursor-2');
        await repo.set('linear', 'cursor-3');

        const rows = await db.selectFrom('runner.sourceCursors').selectAll().where('project', '=', project).where('source', '=', 'linear').execute();
        expect(rows).toHaveLength(1);
        expect(await repo.get('linear')).toBe('cursor-3');
    });

    it('keys by (project, source): a row written for one project is invisible from another', async () => {
        const { repo: repoA } = freshRepo();
        const { repo: repoB } = freshRepo();

        await repoA.set('linear', 'cursor-1');

        expect(await repoB.get('linear')).toBeUndefined();
    });

    it('keys by (project, source): two sources in the same project never share a cursor', async () => {
        const { repo } = freshRepo();

        await repo.set('linear', 'linear-cursor');
        await repo.set('github', 'github-cursor');

        expect(await repo.get('linear')).toBe('linear-cursor');
        expect(await repo.get('github')).toBe('github-cursor');
    });
});
