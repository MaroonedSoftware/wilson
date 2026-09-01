import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import type { DB } from '#modules/data/db.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { runAsProject } from '#modules/board/project.context.js';
import { ProjectScopedBoardConfig } from '#modules/board/board.config.js';
import { assertRoutesResolve, findStage, parseStages, ProjectStagesSchema, StageConfigError } from '#modules/stages/stage.config.js';
import { PostgresStageConfigStore, StaticStageConfigStore } from '#modules/stages/stage.config.store.js';
import { seedStageConfig, testDb, uniqueProject } from '#tests/support/test.db.js';

/**
 * `StageConfigStore.load` is called twice for the same project on every dispatch (`StageDispatcher.run`
 * and `CardStageJob.runStage`), on every poller tick, and from several API routes — each one a YAML
 * parse, a zod validation and a route check of a document that changes only when a person saves
 * it. The cache key is the newest row's id, because every save is a new row: these pin that repeats
 * are served from the cache, and that every save gets through, the same two halves the file cache's
 * mtime/size test used to pin.
 */
const VALID = `
stages:
  - name: implementing
    mode: agent
    model: claude-opus
    instructions: build it
    onPass: merged
    onFail: implementing
`;

const OTHER_VALID = `
stages:
  - name: reviewing
    mode: agent
    model: claude-opus
    instructions: review it
    onPass: merged
    onFail: reviewing
`;

const BROKEN_ROUTE =
    'stages:\n  - name: implementing\n    mode: agent\n    model: claude-opus\n    instructions: x\n    onPass: nowhere\n    onFail: implementing\n';

let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

describe('PostgresStageConfigStore', () => {
    let project: string;
    let store: PostgresStageConfigStore;

    beforeEach(async () => {
        project = uniqueProject();
        store = new PostgresStageConfigStore(new StaticBoardConfig(project, '/tmp/board', '/tmp/code', '/tmp/wt', '/tmp/run'), db);
        await seedStageConfig(db, project, VALID);
    });

    it('returns the very same object on a repeat load of an unchanged config', async () => {
        const first = await store.load();
        const second = await store.load();

        expect(second).toBe(first);
        expect(first.stages[0]!.name).toBe('implementing');
    });

    it('re-parses once a new document has been saved', async () => {
        const first = await store.load();

        await store.save(OTHER_VALID, 'switch to reviewing');

        const second = await store.load();
        expect(second).not.toBe(first);
        expect(second.stages[0]!.name).toBe('reviewing');
    });

    /**
     * The operator fixing a broken config is exactly the case that must not be served a remembered
     * answer — and there is nothing to remember, because a failed parse never reaches the cache.
     */
    it('keeps throwing for an invalid stored document, and picks up the fix', async () => {
        // Straight into the table, bypassing `save`'s validation: a document stored before a schema
        // change is the case a stored-but-invalid row stands for.
        await seedStageConfig(db, project, BROKEN_ROUTE, 'stored before the schema changed');
        await expect(store.load()).rejects.toBeInstanceOf(StageConfigError);
        await expect(store.load()).rejects.toBeInstanceOf(StageConfigError);

        await store.save(VALID, 'fix it');

        await expect(store.load()).resolves.toMatchObject({ stages: [{ name: 'implementing' }] });
    });

    /**
     * A project with no config at all is the same "the config itself is broken" failure as an
     * invalid one — not a lookup miss for one card's stage. `classifyDispatchFailure` defers the
     * former and poisons the latter, so the kind is what matters here.
     */
    it('tags a project with no stage config as "config-invalid", naming the project and the fix', async () => {
        const empty = uniqueProject();
        const emptyStore = new PostgresStageConfigStore(new StaticBoardConfig(empty, '/tmp/board', '/tmp/code', '/tmp/wt', '/tmp/run'), db);

        const error = await emptyStore.load().catch((err: unknown) => err);

        expect(error).toBeInstanceOf(StageConfigError);
        expect((error as StageConfigError).kind).toBe('config-invalid');
        expect((error as StageConfigError).message).toContain(empty);
        expect((error as StageConfigError).message).toContain('wilson board init');
        expect(await emptyStore.read()).toBeUndefined();
    });

    it('refuses to save a document that would not load, and writes nothing', async () => {
        const before = await store.read();

        const error = await store.save(BROKEN_ROUTE, 'oops').catch((err: unknown) => err);

        expect(error).toBeInstanceOf(StageConfigError);
        expect((error as StageConfigError).kind).toBe('config-invalid');
        expect((error as StageConfigError).message).toContain('nowhere');
        expect(await store.read()).toEqual(before);
    });

    it('answers read and versions with the newest document first', async () => {
        const saved = await store.save(OTHER_VALID, 'second');

        const current = await store.read();
        expect(current).toMatchObject({ id: saved.id, yaml: OTHER_VALID, message: 'second' });

        const versions = await store.versions();
        expect(versions.map(v => v.message)).toEqual(['second', 'test']);
        expect(versions[0]!.id).toBe(saved.id);
        expect(await store.versions(1)).toHaveLength(1);
    });

    /**
     * Every caller shares one instance where each used to get its own parse. Freezing makes that
     * safe by construction rather than by every future caller happening not to mutate what it got.
     */
    it('hands back a deeply frozen config', async () => {
        const stages = await store.load();

        expect(Object.isFrozen(stages)).toBe(true);
        expect(Object.isFrozen(stages.stages)).toBe(true);
        expect(Object.isFrozen(stages.stages[0])).toBe(true);
        expect(() => {
            (stages.stages[0] as { name: string }).name = 'mutated';
        }).toThrow(TypeError);
    });

    /**
     * The store reads `BoardConfig.project` fresh on every call, so under `runAsProject` the same
     * instance answers for whichever project's work is on the call stack — the property every
     * per-project consumer (`Poller.tickProject`, `CardStageJob.run`) relies on.
     */
    it('answers for the project on the call stack under runAsProject', async () => {
        const alpha = uniqueProject();
        const beta = uniqueProject();
        await seedStageConfig(db, alpha, VALID);
        await seedStageConfig(db, beta, OTHER_VALID);
        const config = new ProjectScopedBoardConfig(alpha);
        for (const name of [alpha, beta]) config.register({ name, boardRoot: '/b', codeRoot: '/c', worktreeRoot: '/w', runRoot: '/r' });
        const scoped = new PostgresStageConfigStore(config, db);

        const fromAlpha = await runAsProject(alpha, () => scoped.load());
        const fromBeta = await runAsProject(beta, () => scoped.load());

        expect(fromAlpha.stages[0]!.name).toBe('implementing');
        expect(fromBeta.stages[0]!.name).toBe('reviewing');
    });
});

describe('StaticStageConfigStore', () => {
    it('loads the document it was constructed with, and appends on save', async () => {
        const store = new StaticStageConfigStore(VALID);

        expect((await store.load()).stages[0]!.name).toBe('implementing');

        await store.save(OTHER_VALID, 'switch');
        expect((await store.load()).stages[0]!.name).toBe('reviewing');
        expect((await store.versions()).map(v => v.message)).toEqual(['switch', 'initial']);
    });

    it('is "config-invalid" when constructed empty, like a project with no row', async () => {
        const error = await new StaticStageConfigStore().load().catch((err: unknown) => err);

        expect(error).toBeInstanceOf(StageConfigError);
        expect((error as StageConfigError).kind).toBe('config-invalid');
    });

    it('refuses an invalid save the way the real store does', async () => {
        const store = new StaticStageConfigStore(VALID);

        await expect(store.save('stages: [', 'broken yaml')).rejects.toBeInstanceOf(StageConfigError);
        await expect(store.save(BROKEN_ROUTE, 'broken route')).rejects.toBeInstanceOf(StageConfigError);
        expect((await store.versions()).map(v => v.message)).toEqual(['initial']);
    });
});

/**
 * `parseStages` is the one place a document becomes a `ProjectStages`, shared by `load` and `save`.
 * Every way a document can be wrong — not YAML, not the schema, a route to nowhere — is
 * `config-invalid`, naming `source` so the error says which document.
 */
describe('parseStages', () => {
    it('names the source in every kind of refusal', () => {
        for (const raw of ['stages: [', 'stages:\n  - name: x\n', BROKEN_ROUTE]) {
            const error = (() => {
                try {
                    parseStages(raw, 'stage config 42');
                } catch (err) {
                    return err as StageConfigError;
                }
                throw new Error('expected parseStages to throw');
            })();
            expect(error).toBeInstanceOf(StageConfigError);
            expect(error.kind).toBe('config-invalid');
            expect(error.message).toContain('stage config 42');
        }
    });
});

/**
 * Card 0031. `StageConfigError` used to be one flat class with no way to tell "this job named a
 * stage that does not exist" (a fact about this one card, deterministic, poisons) apart from
 * "the stage config itself will not load" (a fact about the config, true for every card, defers).
 * Both `findStage` and `assertRoutesResolve` throw the same class, so what has to be pinned is the
 * `kind` each throw site sets — `classifyDispatchFailure` branches on nothing else.
 */
describe('StageConfigError.kind distinguishes a missing stage from a broken config', () => {
    const stages = ProjectStagesSchema.parse({
        stages: [{ name: 'implementing', mode: 'agent', model: 'claude-opus', instructions: 'do it', onPass: 'merged', onFail: 'implementing' }],
    });

    it('tags a stage lookup miss as "stage-not-found", naming the stage that was looked up and the stages that do exist', () => {
        expect(() => findStage(stages, 'reviewing')).toThrow(StageConfigError);

        const error = (() => {
            try {
                findStage(stages, 'reviewing');
            } catch (err) {
                return err as StageConfigError;
            }
            throw new Error('expected findStage to throw');
        })();

        expect(error.kind).toBe('stage-not-found');
        expect(error.message).toContain('reviewing');
        expect(error.message).toContain('implementing');
    });

    it('tags a dangling route as "config-invalid", not "stage-not-found"', () => {
        const brokenRoutes = ProjectStagesSchema.parse({
            stages: [{ name: 'implementing', mode: 'agent', model: 'claude-opus', instructions: 'do it', onPass: 'nowhere', onFail: 'implementing' }],
        });

        const error = (() => {
            try {
                assertRoutesResolve(brokenRoutes);
            } catch (err) {
                return err as StageConfigError;
            }
            throw new Error('expected assertRoutesResolve to throw');
        })();

        expect(error).toBeInstanceOf(StageConfigError);
        expect(error.kind).toBe('config-invalid');
    });
});
