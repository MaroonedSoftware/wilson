import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { parse as parseYaml } from 'yaml';
import type { DB } from '#modules/data/db.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { findStage, parseStages, type StageRouting } from '#modules/stages/stage.config.js';
import { PostgresStageConfigStore } from '#modules/stages/stage.config.store.js';
import { seedStageConfig, testDb, uniqueProject } from '#tests/support/test.db.js';

/** Shaped like Tower's document: commentary, routing kept in rows, a shared block, and every lane we have. */
const LIVE = `
# Commentary that has no column.
scopeViolation: kickback
alwaysAllowed:
  - pnpm-lock.yaml
deny: []
sandbox:
  enabled: true
  allowedDomains:
    - registry.npmjs.org
stages:
  # Interactive plan authoring.
  - name: planning
    mode: manual
    worktree: none
    onPass: backlog
    onFail: parking-lot
    maxKickbacks: 3
    instructions: |
      Plan it.

        Keep this indent, and this trailing space: 
  - name: backlog
    mode: manual
    worktree: none
    onPass: scope-check
    onFail: planning
    instructions: Not dispatched.
  - name: scope-check
    placement: any
    mode: agent
    worktree: readonly
    maxSteps: 80
    maxInputTokens: 20000000
    onPass: implementing
    onFail: planning
    instructions: Judge the plan.
  - name: implementing
    placement: any
    mode: agent
    allowedCommands:
      - pnpm test
    setupCommand: pnpm install --frozen-lockfile
    onPass: merged
    onFail: implementing
    instructions: Build it.
`;

const ROUTES: [string, string, string, string][] = [
    ['planning', 'api', 'anthropic', 'claude-opus-5'],
    ['backlog', 'api', 'anthropic', 'claude-sonnet-5'],
    ['scope-check', 'cli', 'anthropic', 'claude-opus-5-5'],
    ['implementing', 'cli', 'anthropic', 'claude-opus-5-5'],
];

describe('lane tables', () => {
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
    });

    const seedLive = async () => {
        await db.insertInto('wilson.stageConfigs').values({ project, yaml: LIVE, message: 'test' }).execute();
        await db
            .insertInto('wilson.stageRouting')
            .values(ROUTES.map(([stage, adapter, provider, model]) => ({ project, stage, adapter, provider, model, message: 'test' })))
            .execute();
    };

    const revisions = () => db.selectFrom('wilson.laneRevisions').selectAll().where('project', '=', project).orderBy('id').execute();
    const lanes = () => db.selectFrom('wilson.lanes').selectAll().where('project', '=', project).orderBy('position').execute();

    it('loads exactly what the document said, routing included', async () => {
        await seedLive();
        const routing = new Map(ROUTES.map(([stage, adapter, provider, model]) => [stage, { adapter, provider, model } as StageRouting]));
        const fromDocument = parseStages(LIVE, 'test', routing);

        await store.importLanes();

        const withoutManualRouting = fromDocument.stages.map(({ model, ...stage }) =>
            stage.name === 'backlog' ? stage : { ...stage, model, onPass: stage.onPass === 'merged' ? 'done' : stage.onPass },
        );
        expect((await store.load()).stages).toEqual(withoutManualRouting);
        expect((await lanes()).map(lane => lane.name)).toEqual(['planning', 'backlog', 'scope-check', 'implementing']);
    });

    it('keeps instructions byte for byte', async () => {
        await seedLive();
        await store.importLanes();

        const { stages } = parseYaml(LIVE) as { stages: { name: string; instructions: string }[] };
        const expected = stages.find(stage => stage.name === 'planning')!;
        expect(findStage(await store.load(), 'planning').instructions).toBe(expected.instructions);
        expect(expected.instructions).toContain('trailing space: \n');
    });

    it('stores only what the document wrote, so a schema default stays a default', async () => {
        await seedLive();
        await store.importLanes();

        const implementing = (await lanes()).find(lane => lane.name === 'implementing');
        expect(implementing?.settings).toEqual({
            placement: 'any',
            allowedCommands: ['pnpm test'],
            setupCommand: 'pnpm install --frozen-lockfile',
        });
    });

    it('clears routing from a lane that runs no model, and keeps it on planning', async () => {
        await seedLive();
        await store.importLanes();

        const byName = new Map((await lanes()).map(lane => [lane.name, lane]));
        expect(byName.get('backlog')?.model ?? undefined).toBeUndefined();
        expect(byName.get('planning')?.model).toBe('claude-opus-5');
    });

    it('refuses routing for a lane that runs no model', async () => {
        await seedLive();
        await store.importLanes();

        await expect(store.saveRouting('backlog', { adapter: 'api', provider: 'anthropic', model: 'x' }, 'no')).rejects.toMatchObject({
            kind: 'config-invalid',
        });
    });

    it('writes nothing on a second import', async () => {
        await seedLive();
        await store.importLanes();
        const before = await revisions();

        await store.importLanes();

        expect(await revisions()).toEqual(before);
    });

    it('imports a project with a lane nothing else knows about', async () => {
        await seedStageConfig(
            db,
            project,
            'stages:\n  - name: triage\n    mode: command\n    model: x\n    instructions: t\n    onPass: merged\n    onFail: triage\n',
        );
        await store.importLanes();

        expect(findStage(await store.load(), 'triage').mode).toBe('command');
    });

    it('does nothing for a project with no document', async () => {
        await store.importLanes();

        expect(await lanes()).toEqual([]);
        await expect(store.load()).rejects.toMatchObject({ kind: 'config-invalid' });
    });

    it('refuses an invalid document and writes nothing', async () => {
        await db
            .insertInto('wilson.stageConfigs')
            .values({
                project,
                message: 'test',
                yaml: 'stages:\n  - name: a\n    mode: agent\n    model: x\n    instructions: t\n    onPass: nowhere\n    onFail: a\n',
            })
            .execute();

        await expect(store.importLanes()).rejects.toMatchObject({ kind: 'config-invalid' });

        expect(await lanes()).toEqual([]);
        expect(await revisions()).toEqual([]);
    });

    it('catches up with a newer document on the next import, one revision per lane it changes', async () => {
        await seedLive();
        await store.importLanes();
        const before = (await revisions()).length;

        const withoutCheck = LIVE.replace(/ {2}- name: scope-check[\s\S]*?Judge the plan\.\n/, '')
            .replace('onPass: scope-check', 'onPass: implementing')
            .replace('Build it.', 'Build it better.');
        await db.insertInto('wilson.stageConfigs').values({ project, yaml: withoutCheck, message: 'test' }).execute();
        await store.importLanes();

        const added = (await revisions()).slice(before);
        expect(added.map(({ lane, snapshot }) => ({ lane, removed: snapshot == null }))).toEqual(
            expect.arrayContaining([
                { lane: 'implementing', removed: false },
                { lane: 'scope-check', removed: true },
            ]),
        );
        expect((await lanes()).map(lane => lane.name)).toEqual(['planning', 'backlog', 'implementing']);
    });

    it('sends a routing change to the lane, seen straight after a cached load, with a revision', async () => {
        await seedLive();
        await store.importLanes();
        await store.load();
        const before = (await revisions()).length;

        await store.saveRouting('implementing', { adapter: 'api', provider: 'openai', model: 'gpt-5' }, 'try openai');

        expect(findStage(await store.load(), 'implementing')).toMatchObject({ adapter: 'api', provider: 'openai', model: 'gpt-5' });
        const added = (await revisions()).slice(before);
        expect(added).toHaveLength(1);
        expect(added[0]).toMatchObject({ lane: 'implementing', message: 'try openai' });
    });

    describe('folding challenge into review', () => {
        const WITH_CHALLENGE = `
stages:
  - name: review
    mode: agent
    model: claude-opus-5-5
    worktree: readonly
    onPass: ready
    onFail: challenge
    instructions: Find what is wrong.
  - name: challenge
    mode: agent
    model: claude-haiku
    worktree: readonly
    worktreeFrom: branch
    placement: any
    maxSteps: 100
    allowedCommands:
      - git diff
    setupCommand: pnpm install --frozen-lockfile
    onPass: ready
    onFail: implementing
    maxKickbacks: 3
    instructions: |
      Refute it.

        Keep this indent, and this trailing space: 
  - name: ready
    mode: manual
    onPass: merged
    onFail: implementing
    instructions: Wait.
  - name: implementing
    mode: agent
    model: claude-opus-5-5
    onPass: review
    onFail: implementing
    instructions: Build it.
`;
        const seed = () => db.insertInto('wilson.stageConfigs').values({ project, yaml: WITH_CHALLENGE, message: 'test' }).execute();

        it('makes it a step on the lane, instructions byte for byte, and routes around it', async () => {
            await seed();
            await store.importLanes();

            const stages = await store.load();
            expect(stages.stages.map(stage => stage.name)).toEqual(['review', 'ready', 'implementing']);
            const review = findStage(stages, 'review');
            expect(review).toMatchObject({ onPass: 'ready', onFail: 'implementing' });

            const { stages: raw } = parseYaml(WITH_CHALLENGE) as { stages: { name: string; instructions: string }[] };
            const challenge = findStage(stages, 'review', 'challenge');
            expect(challenge.instructions).toBe(raw.find(stage => stage.name === 'challenge')!.instructions);
            expect(challenge).toMatchObject({
                maxSteps: 100,
                placement: 'any',
                worktreeFrom: 'branch',
                allowedCommands: ['git diff'],
                onFail: 'implementing',
            });
            // It runs on the lane's routing, not the one the old lane had.
            expect(challenge.model).toBe('claude-opus-5-5');
        });

        it('moves a card sitting in the old lane to the new one, recording it, and does nothing the second time', async () => {
            await seed();
            await db.insertInto('wilson.cards').values({ project, id: '0001', title: 't', stage: 'challenge', body: '', retries: '{}' }).execute();

            await store.importLanes();
            const after = await db.selectFrom('wilson.cards').select('stage').where('project', '=', project).executeTakeFirstOrThrow();
            expect(after.stage).toBe('review');
            const transitions = () =>
                db
                    .selectFrom('wilson.cardEvents')
                    .select('payload')
                    .where('project', '=', project)
                    .where('type', '=', 'transition.written')
                    .execute();
            expect(await transitions()).toHaveLength(1);

            const before = await revisions();
            await store.importLanes();
            expect(await revisions()).toEqual(before);
            expect(await transitions()).toHaveLength(1);
        });

        it('folds lanes an earlier import already wrote', async () => {
            await seedLive();
            await store.importLanes();
            await db
                .insertInto('wilson.lanes')
                .values([
                    {
                        project,
                        name: 'review',
                        position: 90,
                        mode: 'agent',
                        worktree: 'readonly',
                        onPass: 'done',
                        onFail: 'challenge',
                        model: 'x',
                        instructions: 'r',
                    },
                    {
                        project,
                        name: 'challenge',
                        position: 91,
                        mode: 'agent',
                        worktree: 'readonly',
                        onPass: 'done',
                        onFail: 'implementing',
                        model: 'x',
                        instructions: 'c',
                    },
                ])
                .execute();

            await store.importLanes();

            expect(findStage(await store.load(), 'review', 'challenge').instructions).toBe('c');
            expect((await lanes()).some(lane => lane.name === 'challenge')).toBe(false);
        });

        it('leaves a challenge lane alone in a project with no review lane', async () => {
            await seedStageConfig(
                db,
                project,
                'stages:\n  - name: challenge\n    mode: agent\n    model: x\n    instructions: c\n    onPass: merged\n    onFail: challenge\n',
            );

            expect((await lanes()).map(lane => lane.name)).toEqual(['challenge']);
        });
    });

    describe('patchLane', () => {
        beforeEach(async () => {
            await seedLive();
            await store.importLanes();
        });

        it('changes one setting, seen straight after a cached load, with one revision', async () => {
            await store.load();
            const before = (await revisions()).length;

            await store.patchLane('implementing', { settings: { maxSteps: 99 } }, 'more steps');

            expect(findStage(await store.load(), 'implementing').maxSteps).toBe(99);
            const added = (await revisions()).slice(before);
            expect(added.map(({ lane, message }) => ({ lane, message }))).toEqual([{ lane: 'implementing', message: 'more steps' }]);
        });

        it('removes a setting given null, back to its default', async () => {
            await store.patchLane('implementing', { settings: { setupCommand: null } }, 'no setup');

            expect(findStage(await store.load(), 'implementing').setupCommand).toBeUndefined();
        });

        it('leaves other settings alone and records nothing for a change that changes nothing', async () => {
            const before = (await revisions()).length;

            await store.patchLane('implementing', { instructions: 'Build it.' }, 'same');

            expect(await revisions()).toHaveLength(before);
            expect(findStage(await store.load(), 'implementing').allowedCommands).toEqual(['pnpm test']);
        });

        it('refuses a route to nowhere, a setting that fails the schema, and a reserved setting, writing nothing', async () => {
            const before = await revisions();

            await expect(store.patchLane('implementing', { onPass: 'nowhere' }, 'x')).rejects.toMatchObject({ kind: 'config-invalid' });
            await expect(store.patchLane('implementing', { settings: { maxSteps: 0 } }, 'x')).rejects.toMatchObject({ kind: 'config-invalid' });
            await expect(store.patchLane('implementing', { settings: { model: 'x' } }, 'x')).rejects.toMatchObject({ kind: 'config-invalid' });

            expect(await revisions()).toEqual(before);
        });

        it('refuses a change that leaves a lane on routing its engine cannot run', async () => {
            await store.patchLane('implementing', { settings: { isolated: true, placement: 'remote' } }, 'isolate');
            await store.saveRouting('implementing', { adapter: 'codex', provider: 'openai', model: 'gpt-5' }, 'codex');

            await expect(store.patchLane('implementing', { settings: { isolated: null, placement: 'any' } }, 'x')).rejects.toMatchObject({
                kind: 'config-invalid',
            });
        });

        it('says stage-not-found for no such lane', async () => {
            await expect(store.patchLane('nope', { instructions: 'x' }, 'x')).rejects.toMatchObject({ kind: 'stage-not-found' });
        });

        it('lists lanes in board order, and revisions for one lane, newest first', async () => {
            await store.patchLane('implementing', { instructions: 'First.' }, 'first');
            await store.patchLane('implementing', { instructions: 'Second.' }, 'second');

            expect((await store.lanes()).map(lane => lane.name)).toEqual(['planning', 'backlog', 'scope-check', 'implementing']);
            expect((await store.laneRevisions('implementing', 2)).map(revision => revision.message)).toEqual(['second', 'first']);
        });
    });

    it('hands back the same frozen object for an unchanged config', async () => {
        await seedLive();
        await store.importLanes();

        const first = await store.load();
        expect(await store.load()).toBe(first);
        expect(Object.isFrozen(first.stages)).toBe(true);
    });
});
