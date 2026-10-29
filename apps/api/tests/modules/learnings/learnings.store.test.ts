import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import type { DB } from '#modules/data/db.js';
import { ProjectScopedBoardConfig, StaticBoardConfig } from '#modules/board/board.config.js';
import { runAsProject } from '#modules/board/project.context.js';
import { PostgresLearningsStore, StaticLearningsStore } from '#modules/learnings/learnings.store.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';

/**
 * Card 0239. `LearningsStore` clones `StageConfigStore`'s append-only shape, but with none of its
 * validation: a learnings document is free text, so `load`/`read` never throw, and a project with
 * no row yet answers with an empty document rather than an error (AC3) — the behaviour these pin
 * against `PostgresLearningsStore` (a real `wilson.learnings` row) and `StaticLearningsStore` (its
 * in-memory test double) both.
 */
let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

describe('PostgresLearningsStore', () => {
    let project: string;
    let store: PostgresLearningsStore;

    beforeEach(() => {
        project = uniqueProject();
        store = new PostgresLearningsStore(new StaticBoardConfig(project, '/tmp/code', '/tmp/wt', '/tmp/run'), db);
    });

    it('answers load with the empty string and read with undefined for a project with no saved document (AC3)', async () => {
        expect(await store.load()).toBe('');
        expect(await store.read()).toBeUndefined();
    });

    it('saves a document and reads it back as the current one, with the given message', async () => {
        const saved = await store.save('# Learnings\n\nDon\'t do that.', 'first learning');

        expect(saved.markdown).toBe("# Learnings\n\nDon't do that.");
        expect(saved.message).toBe('first learning');
        expect(await store.load()).toBe("# Learnings\n\nDon't do that.");
        await expect(store.read()).resolves.toMatchObject({ id: saved.id, markdown: "# Learnings\n\nDon't do that.", message: 'first learning' });
    });

    it('never overwrites: every save is a new row, and load/read answer with the newest one', async () => {
        await store.save('first', 'one');
        const second = await store.save('second', 'two');

        expect(await store.load()).toBe('second');
        await expect(store.read()).resolves.toMatchObject({ id: second.id, markdown: 'second' });

        const versions = await store.versions();
        expect(versions.map(v => v.message)).toEqual(['two', 'one']);
    });

    it('accepts an empty markdown as a valid save, which becomes the current document (AC4)', async () => {
        await store.save('some learnings', 'seed');

        const saved = await store.save('', 'retire everything');

        expect(saved.markdown).toBe('');
        expect(await store.load()).toBe('');
        await expect(store.read()).resolves.toMatchObject({ markdown: '', message: 'retire everything' });
    });

    it('lists versions newest first, each carrying its own message, and honours a limit (AC2)', async () => {
        await store.save('v1', 'first save');
        await store.save('v2', 'second save');
        await store.save('v3', 'third save');

        const versions = await store.versions();
        expect(versions.map(v => v.message)).toEqual(['third save', 'second save', 'first save']);

        expect(await store.versions(2)).toHaveLength(2);
    });

    it('answers for the project on the call stack under runAsProject, never mixing two projects\' documents', async () => {
        const alpha = uniqueProject();
        const beta = uniqueProject();
        const config = new ProjectScopedBoardConfig(alpha);
        for (const name of [alpha, beta]) config.register({ name, codeRoot: '/c', worktreeRoot: '/w', runRoot: '/r' });
        const scoped = new PostgresLearningsStore(config, db);

        await runAsProject(alpha, () => scoped.save('alpha learnings', 'a'));
        await runAsProject(beta, () => scoped.save('beta learnings', 'b'));

        const fromAlpha = await runAsProject(alpha, () => scoped.load());
        const fromBeta = await runAsProject(beta, () => scoped.load());

        expect(fromAlpha).toBe('alpha learnings');
        expect(fromBeta).toBe('beta learnings');
    });
});

describe('StaticLearningsStore', () => {
    it('answers load with the empty string and read with undefined when constructed with no document, like a project with no row', async () => {
        const store = new StaticLearningsStore();

        expect(await store.load()).toBe('');
        expect(await store.read()).toBeUndefined();
    });

    it('loads the document it was constructed with', async () => {
        const store = new StaticLearningsStore('seeded learnings', 'seeded');

        expect(await store.load()).toBe('seeded learnings');
        await expect(store.read()).resolves.toMatchObject({ markdown: 'seeded learnings', message: 'seeded' });
    });

    it('appends on save rather than overwriting, and never refuses an empty markdown', async () => {
        const store = new StaticLearningsStore('first');

        await store.save('second', 'two');
        await store.save('', 'retire');

        expect(await store.load()).toBe('');
        expect((await store.versions()).map(v => v.message)).toEqual(['retire', 'two', 'initial']);
    });
});
