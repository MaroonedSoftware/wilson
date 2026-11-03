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
 * and `CardStageJob.runStage`), on every poller tick, and from several API routes, for rows that change
 * only when a person changes them. The cache key is the newest revision's id, because every change adds
 * one: these pin that repeats are served from the cache, and that every change gets through.
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
        store = new PostgresStageConfigStore(new StaticBoardConfig(project, '/tmp/code', '/tmp/wt', '/tmp/run'), db);
        await seedStageConfig(db, project, VALID);
    });

    it('lets a routing change win, seen straight after a cached load', async () => {
        await store.load();

        await store.saveRouting('implementing', { adapter: 'api', provider: 'xai', model: 'grok-5' }, 'test');

        expect(findStage(await store.load(), 'implementing')).toMatchObject({ adapter: 'api', provider: 'xai', model: 'grok-5' });
    });

    it('returns the very same object on a repeat load of an unchanged config', async () => {
        expect(await store.load()).toBe(await store.load());
    });

    it('rebuilds once a lane has changed', async () => {
        const first = await store.load();

        await store.patchLane('implementing', { instructions: 'build it well' }, 'test');

        const second = await store.load();
        expect(second).not.toBe(first);
        expect(findStage(second, 'implementing').instructions).toBe('build it well');
    });

    it('keeps throwing for rows that no longer validate, and picks up the fix', async () => {
        await db.updateTable('wilson.lanes').set({ onPass: 'nowhere' }).where('project', '=', project).execute();
        await db.insertInto('wilson.laneRevisions').values({ project, lane: 'implementing', message: 'broke it' }).execute();

        await expect(store.load()).rejects.toMatchObject({ kind: 'config-invalid' });
        await expect(store.load()).rejects.toMatchObject({ kind: 'config-invalid' });

        await db.updateTable('wilson.lanes').set({ onPass: 'merged' }).where('project', '=', project).execute();
        await db.insertInto('wilson.laneRevisions').values({ project, lane: 'implementing', message: 'fixed it' }).execute();
        expect(findStage(await store.load(), 'implementing').onPass).toBe('merged');
    });

    it('tags a project with no lanes as "config-invalid", naming the project and the fix', async () => {
        const bare = uniqueProject();
        const empty = new PostgresStageConfigStore(new StaticBoardConfig(bare, '/tmp/code', '/tmp/wt', '/tmp/run'), db);

        const error = await empty.load().catch((err: unknown) => err);

        expect(error).toBeInstanceOf(StageConfigError);
        expect((error as StageConfigError).kind).toBe('config-invalid');
        expect((error as StageConfigError).message).toContain(bare);
        expect((error as StageConfigError).message).toContain('wilson board init');
    });

    it('hands back a deeply frozen config', async () => {
        const stages = await store.load();

        expect(Object.isFrozen(stages)).toBe(true);
        expect(Object.isFrozen(stages.stages[0])).toBe(true);
        expect(Object.isFrozen(stages.stages[0]!.allowedCommands)).toBe(true);
    });

    it('answers for the project on the call stack under runAsProject', async () => {
        const alpha = uniqueProject();
        const beta = uniqueProject();
        await seedStageConfig(db, alpha, VALID);
        await seedStageConfig(db, beta, OTHER_VALID);
        const config = new ProjectScopedBoardConfig(alpha);
        for (const name of [alpha, beta]) config.register({ name, codeRoot: '/c', worktreeRoot: '/w', runRoot: '/r' });
        const scoped = new PostgresStageConfigStore(config, db);

        const fromAlpha = await runAsProject(alpha, () => scoped.load());
        const fromBeta = await runAsProject(beta, () => scoped.load());

        expect(fromAlpha.stages[0]!.name).toBe('implementing');
        expect(fromBeta.stages[0]!.name).toBe('reviewing');
    });
});

describe('StaticStageConfigStore', () => {
    it('loads the document it was constructed with, and swaps it on save', async () => {
        const store = new StaticStageConfigStore(VALID);

        expect((await store.load()).stages[0]!.name).toBe('implementing');

        await store.save(OTHER_VALID);
        expect((await store.load()).stages[0]!.name).toBe('reviewing');
    });

    it('is "config-invalid" when constructed empty, like a project with no row', async () => {
        const error = await new StaticStageConfigStore().load().catch((err: unknown) => err);

        expect(error).toBeInstanceOf(StageConfigError);
        expect((error as StageConfigError).kind).toBe('config-invalid');
    });

    it('refuses an invalid save, keeping what it had', async () => {
        const store = new StaticStageConfigStore(VALID);

        await expect(store.save('stages: [')).rejects.toBeInstanceOf(StageConfigError);
        await expect(store.save(BROKEN_ROUTE)).rejects.toBeInstanceOf(StageConfigError);
        expect((await store.load()).stages[0]!.name).toBe('implementing');
    });
});

/**
 * `parseStages` is the one place a document becomes a `ProjectStages`, shared by an import and `StaticStageConfigStore`.
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
