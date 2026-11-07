import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import type { DB } from '#modules/data/db.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { findStage, parseStages, type StageRouting } from '#modules/stages/stage.config.js';
import { PostgresStageConfigStore } from '#modules/stages/stage.config.store.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';

/**
 * Card 0013: a lane's `webAccess` is one of its settings. It needs no column (`lane.rows.ts` keeps any
 * key without one in `settings`), so it survives a revision of the lane like any other setting, a
 * load straight after a change reads it, and a step runs at its lane's value.
 */
const DOCUMENT = `
stages:
  - name: implementing
    mode: agent
    onPass: merged
    onFail: implementing
    instructions: Build it.
  - name: review
    mode: agent
    worktree: readonly
    onPass: merged
    onFail: implementing
    instructions: Review it.
    steps:
      - name: revise
        on: revise
        instructions: Revise it.
`;

const ROUTES: [string, string, string, string][] = [
    ['implementing', 'cli', 'anthropic', 'claude-opus-5-5'],
    ['review', 'cli', 'anthropic', 'claude-opus-5-5'],
];
const routing = new Map(ROUTES.map(([stage, adapter, provider, model]) => [stage, { adapter, provider, model } as StageRouting]));

describe('webAccess in the stage config', () => {
    it('AC1: is absent unless set, which reads as none', () => {
        expect(findStage(parseStages(DOCUMENT, 'test', routing), 'implementing').webAccess).toBeUndefined();
    });

    it.each(['none', 'github', 'web'])('accepts %s', value => {
        const document = DOCUMENT.replace('    instructions: Build it.', `    instructions: Build it.\n    webAccess: ${value}`);
        expect(findStage(parseStages(document, 'test', routing), 'implementing').webAccess).toBe(value);
    });

    it('refuses any other value', () => {
        const document = DOCUMENT.replace('    instructions: Build it.', '    instructions: Build it.\n    webAccess: everything');
        expect(() => parseStages(document, 'test', routing)).toThrow(/webAccess/);
    });

    it("runs a step at its lane's value", () => {
        const document = DOCUMENT.replace('    instructions: Review it.', '    instructions: Review it.\n    webAccess: github');
        expect(findStage(parseStages(document, 'test', routing), 'review', 'revise').webAccess).toBe('github');
    });
});

describe('webAccess as a lane setting', () => {
    let db: Kysely<DB>;
    let project: string;
    let store: PostgresStageConfigStore;

    beforeAll(() => {
        db = testDb();
    });
    afterAll(async () => {
        await db.destroy();
    });

    beforeEach(async () => {
        project = uniqueProject();
        store = new PostgresStageConfigStore(new StaticBoardConfig(project, '/tmp/code', '/tmp/wt', '/tmp/run'), db);
        await db.insertInto('wilson.stageConfigs').values({ project, yaml: DOCUMENT, message: 'test' }).execute();
        await db
            .insertInto('wilson.stageRouting')
            .values(ROUTES.map(([stage, adapter, provider, model]) => ({ project, stage, adapter, provider, model, message: 'test' })))
            .execute();
        await store.importLanes();
    });

    it('AC9: is stored as a setting, survives a later revision of the lane, and a load reads the latest', async () => {
        await store.load();

        await store.patchLane('implementing', { settings: { webAccess: 'github' } }, 'read github');
        expect(findStage(await store.load(), 'implementing').webAccess).toBe('github');

        await store.patchLane('implementing', { settings: { maxSteps: 99 } }, 'more steps');
        await store.patchLane('implementing', { instructions: 'Build it well.' }, 'reword');
        const after = findStage(await store.load(), 'implementing');
        expect(after).toMatchObject({ webAccess: 'github', maxSteps: 99, instructions: 'Build it well.' });

        await store.patchLane('implementing', { settings: { webAccess: 'none' } }, 'no web');
        expect(findStage(await store.load(), 'implementing').webAccess).toBe('none');
    });

    it('AC1: goes back to unset, read as none, when removed', async () => {
        await store.patchLane('implementing', { settings: { webAccess: 'github' } }, 'read github');
        await store.patchLane('implementing', { settings: { webAccess: null } }, 'unset');

        expect(findStage(await store.load(), 'implementing').webAccess).toBeUndefined();
    });

    it('refuses a value outside none, github and web, writing nothing', async () => {
        await expect(store.patchLane('implementing', { settings: { webAccess: 'everything' } }, 'too much')).rejects.toMatchObject({
            kind: 'config-invalid',
        });
        expect(findStage(await store.load(), 'implementing').webAccess).toBeUndefined();
    });

    it('leaves every other lane as it was', async () => {
        await store.patchLane('implementing', { settings: { webAccess: 'github' } }, 'read github');

        expect(findStage(await store.load(), 'review').webAccess).toBeUndefined();
    });
});
