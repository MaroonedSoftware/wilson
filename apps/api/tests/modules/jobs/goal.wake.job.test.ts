import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';
import { DateTime } from 'luxon';
import { ConsoleLogger } from '@maroonedsoftware/logger';
import { ProjectRepository } from '#modules/board/project.repository.js';
import { ApiChatEngine } from '#modules/chat/api.chat.engine.js';
import { ChatAttachmentRepository } from '#modules/chat/chat.attachment.repository.js';
import { ChatMessageRepository } from '#modules/chat/chat.message.repository.js';
import { ChatPendingActionRepository } from '#modules/chat/chat.pending.action.repository.js';
import { ChatQuestionRepository } from '#modules/chat/chat.question.repository.js';
import { ChatService, NOTHING_MORE } from '#modules/chat/chat.service.js';
import { ChatThreadRepository } from '#modules/chat/chat.thread.repository.js';
import { ChatUsageRepository } from '#modules/chat/chat.usage.repository.js';
import type { DB } from '#modules/data/db.js';
import { EventLog } from '#modules/events/event.log.js';
import { GoalRepository, type Goal } from '#modules/goal/goal.repository.js';
import { WAKE_MAX_STEPS } from '#modules/goal/goal.wake.js';
import { GoalWakeJob } from '#modules/jobs/goal.wake.job.js';
import type { SettingDefinition } from '#modules/settings/setting.definition.js';
import { ORCHESTRATOR_DAILY_OUTPUT_TOKENS, ORCHESTRATOR_ENABLED } from '#modules/settings/orchestrator.setting.js';
import type { SettingsStore } from '#modules/settings/settings.store.js';
import type { StageConfigStore } from '#modules/stages/stage.config.store.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';
import { calls, says, scriptedModel } from '../chat/chat.model.fake.js';
import { fakeCatalog, fakeContainer, fakeHandler, fakeSession, type FakeCall } from '../chat/chat.fakes.js';

let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

const logger = new ConsoleLogger();

/** One goal's wake-up end to end: real goals, events, threads and turn storage, on a scripted model. */
describe('GoalWakeJob', () => {
    let project: string;
    let goals: GoalRepository;
    let events: EventLog;
    let goal: Goal;
    let values: Map<string, unknown>;

    const settings = {
        get: async <T>(definition: SettingDefinition<T>) =>
            values.has(definition.key) ? (values.get(definition.key) as T) : definition.defaultValue,
    } as unknown as SettingsStore;
    const stages = {
        load: async () => ({
            stages: [
                { name: 'ready', mode: 'manual' },
                { name: 'testing', mode: 'agent' },
            ],
        }),
    } as unknown as StageConfigStore;

    const setup = (steps: Parameters<typeof scriptedModel>[0]) => {
        const operationCalls: FakeCall[] = [];
        const catalog = fakeCatalog([
            fakeHandler('get_a_goal', true, operationCalls, { result: { cards: [] } }),
            fakeHandler('move_card', false, operationCalls, { result: {} }),
        ]);
        const actions = new ChatPendingActionRepository(db);
        const questions = new ChatQuestionRepository(db);
        const container = fakeContainer(actions, questions);
        const model = scriptedModel(steps);
        const chat = new ChatService(
            container,
            logger,
            new ChatThreadRepository(db),
            new ChatMessageRepository(db),
            new ChatAttachmentRepository(db),
            actions,
            questions,
            new ChatUsageRepository(db),
            goals,
            catalog,
            container.get(ProjectRepository),
            { api: new ApiChatEngine(model.registry), cli: undefined },
            async () => ({ engine: 'api', provider: 'anthropic', model: 'claude-sonnet-5-5' }),
            () => fakeSession,
        );
        return { job: new GoalWakeJob(goals, chat, settings, stages, logger), chat, model, operationCalls };
    };

    const flagged = (cardId = '0001') =>
        events.append({
            project,
            cardId,
            stage: 'testing',
            type: 'transition.written',
            payload: { from: 'testing', to: 'testing', by: 'runner', needsHuman: true, reason: 'retries exhausted' },
        });
    const reread = async () => (await goals.get(goal.id))!;
    const messagesOf = async () => db.selectFrom('wilson.chatMessages').selectAll().where('threadId', '=', BigInt(goal.threadId)).execute();

    beforeEach(async () => {
        project = uniqueProject();
        await db.insertInto('wilson.projects').values({ name: project, codeRoot: '/c', worktreeRoot: '/w', runRoot: '/r' }).execute();
        await db
            .insertInto('wilson.cards')
            .values([
                { project, id: '0001', title: 'In the goal', stage: 'testing', body: '' },
                { project, id: '0002', title: 'Not in the goal', stage: 'testing', body: '' },
            ])
            .execute();
        goals = new GoalRepository(db);
        events = new EventLog(db, logger);
        values = new Map<string, unknown>([[ORCHESTRATOR_ENABLED.key, true]]);
        const thread = await new ChatThreadRepository(db).create('a thread', 'api');
        goal = await goals.create({ threadId: thread.id, project, title: 'Add SSO', outcome: 'o' });
        await goals.linkCard(goal, '0001');
    });

    it("tells the thread what happened, moves its cursor, and stores no note as anyone's message", async () => {
        const { job, model } = setup([says('0001 ran out of retries.')]);
        await flagged();

        await job.run({ goalId: goal.id });

        expect(JSON.stringify(model.prompts[0])).toContain('retries exhausted');
        expect((await messagesOf()).map(message => [message.role, message.content])).toEqual([['assistant', '0001 ran out of retries.']]);
        expect(BigInt((await reread()).lastEventId)).toBeGreaterThan(BigInt(goal.lastEventId));
    });

    it(`stores nothing when nothing needs the person (${NOTHING_MORE}), and does not hear it again`, async () => {
        const { job, model } = setup([says(NOTHING_MORE)]);
        await flagged();

        await job.run({ goalId: goal.id });
        await job.run({ goalId: goal.id });

        expect(await messagesOf()).toEqual([]);
        expect(model.prompts).toHaveLength(1);
    });

    it('proposes a change without making it, and cannot make one', async () => {
        const { job, operationCalls } = setup([
            calls('propose_change', { name: 'move_card', project, arguments: { id: '0001' }, summary: 'Move 0001.' }),
            says('Proposed.'),
        ]);
        await flagged();

        await job.run({ goalId: goal.id });

        expect(operationCalls).toEqual([]);
        const actions = await new ChatPendingActionRepository(db).forThread(goal.threadId);
        expect(actions.map(action => action.status)).toEqual(['pending']);
    });

    it('runs as the orchestrator, with fewer steps than a person gets', async () => {
        const { job, chat } = setup([says('Noted.')]);
        const runNote = vi.spyOn(chat, 'runNote');
        await flagged();

        await job.run({ goalId: goal.id });

        const [, , session, named, options] = runNote.mock.calls[0]!;
        expect(session.subject).toBe('orchestrator');
        expect(named).toBe(project);
        expect(options).toEqual({ maxSteps: WAKE_MAX_STEPS });
    });

    it('holds the goal and keeps its cursor when the turn fails, so nothing is lost', async () => {
        const { job } = setup([]);
        await flagged();

        await job.run({ goalId: goal.id });

        const held = await reread();
        expect(held.lastEventId).toBe(goal.lastEventId);
        expect(held.wakeHeldUntil! > DateTime.now()).toBe(true);
    });

    it('runs nothing while held, and hears the same events once the hold lapses, lifting it', async () => {
        const { job, model } = setup([says('0001 ran out of retries.')]);
        await flagged();
        await goals.holdWake(goal.id, DateTime.now().plus({ minutes: 5 }));

        await job.run({ goalId: goal.id });
        expect(model.prompts).toEqual([]);

        await goals.holdWake(goal.id, DateTime.now().minus({ minutes: 1 }));
        await job.run({ goalId: goal.id });

        expect(model.prompts).toHaveLength(1);
        expect((await reread()).wakeHeldUntil).toBeUndefined();
    });

    it('moves past events worth no turn without spending one', async () => {
        const { job, model } = setup([]);
        await events.append({
            project,
            cardId: '0001',
            stage: 'testing',
            type: 'transition.written',
            payload: { from: 'implementing', to: 'testing', by: 'runner' },
        });

        await job.run({ goalId: goal.id });

        expect(model.prompts).toEqual([]);
        expect(BigInt((await reread()).lastEventId)).toBeGreaterThan(BigInt(goal.lastEventId));
    });

    it("ignores another card's events, and what happened before the goal existed", async () => {
        await flagged('0002');
        const { job, model } = setup([]);

        await job.run({ goalId: goal.id });

        expect(model.prompts).toEqual([]);
        expect((await reread()).lastEventId).toBe(goal.lastEventId);
    });

    describe('runs nothing', () => {
        it('when the project has not turned it on', async () => {
            const { job, model } = setup([]);
            values.set(ORCHESTRATOR_ENABLED.key, false);
            await flagged();

            await job.run({ goalId: goal.id });

            expect(model.prompts).toEqual([]);
            expect((await reread()).lastEventId).toBe(goal.lastEventId);
        });

        it('at the daily ceiling, keeping the events for tomorrow', async () => {
            const { job, model } = setup([]);
            values.set(ORCHESTRATOR_DAILY_OUTPUT_TOKENS.key, 1_000);
            await new ChatUsageRepository(db).record(goal.threadId, { engine: 'api', model: 'm', usage: { outputTokens: 1_000 } });
            await flagged();

            await job.run({ goalId: goal.id });

            expect(model.prompts).toEqual([]);
            expect((await reread()).lastEventId).toBe(goal.lastEventId);
        });

        it('for a paused goal, or one that does not exist', async () => {
            const { job, model } = setup([]);
            await goals.update(goal.id, { status: 'paused' });
            await flagged();

            await job.run({ goalId: goal.id });
            await job.run({ goalId: '999999999' });

            expect(model.prompts).toEqual([]);
        });
    });
});
