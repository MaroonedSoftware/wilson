import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';
import { DateTime } from 'luxon';
import type { JobBroker } from '@maroonedsoftware/jobbroker';
import { ChatThreadRepository } from '#modules/chat/chat.thread.repository.js';
import { ChatUsageRepository } from '#modules/chat/chat.usage.repository.js';
import type { DB } from '#modules/data/db.js';
import { EventLog } from '#modules/events/event.log.js';
import { GoalRepository, type Goal } from '#modules/goal/goal.repository.js';
import { GoalWatcher } from '#modules/jobs/goal.watcher.js';
import { ORCHESTRATOR_DAILY_OUTPUT_TOKENS, ORCHESTRATOR_ENABLED } from '#modules/settings/orchestrator.setting.js';
import type { SettingDefinition } from '#modules/settings/setting.definition.js';
import type { SettingsStore } from '#modules/settings/settings.store.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';

let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

/** The tick against real goals and events. Other tests' goals are in the same table, so these look only at their own. */
describe('GoalWatcher', () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() };
    let project: string;
    let goals: GoalRepository;
    let goal: Goal;
    let values: Map<string, unknown>;
    let sends: Record<string, unknown>[];
    let state: string;
    let watcher: GoalWatcher;

    const event = () => new EventLog(db, logger as never).append({ project, cardId: '0001', stage: 'testing', type: 'stage.blocked', payload: {} });
    const mine = () => sends.filter(payload => payload.goalId === goal.id);

    beforeEach(async () => {
        vi.clearAllMocks();
        project = uniqueProject();
        await db.insertInto('wilson.projects').values({ name: project, codeRoot: '/c', worktreeRoot: '/w', runRoot: '/r' }).execute();
        await db.insertInto('wilson.cards').values({ project, id: '0001', title: 'A card', stage: 'testing', body: '' }).execute();
        goals = new GoalRepository(db);
        const thread = await new ChatThreadRepository(db).create('a thread', 'api');
        goal = await goals.create({ threadId: thread.id, project, title: 'Add SSO', outcome: 'o' });
        await goals.linkCard(goal, '0001');

        values = new Map<string, unknown>([[ORCHESTRATOR_ENABLED.key, true]]);
        sends = [];
        state = 'completed';
        const settings = {
            // Other tests' goals pass through here too, and stay off so they send nothing.
            get: async <T>(definition: SettingDefinition<T>) =>
                values.has(definition.key) ? (values.get(definition.key) as T) : definition.defaultValue,
        } as unknown as SettingsStore;
        const broker = {
            send: async (_name: string, payload: Record<string, unknown>) => {
                sends.push(payload);
                return `job-${sends.length}`;
            },
            getJob: async () => ({ state }),
        } as unknown as JobBroker;
        watcher = new GoalWatcher(goals, broker, settings, logger as never);
    });

    it('sends a wake-up for a goal with unread events', async () => {
        await event();

        await watcher.tick();

        expect(mine()).toEqual([{ goalId: goal.id }]);
    });

    it('sends nothing when nothing has happened', async () => {
        await watcher.tick();

        expect(mine()).toEqual([]);
    });

    it('sends nothing when the project has not turned it on', async () => {
        values.set(ORCHESTRATOR_ENABLED.key, false);
        await event();

        await watcher.tick();

        expect(mine()).toEqual([]);
    });

    it.each(['created', 'retry', 'active'])('sends no second wake-up while the last is %s', async unfinished => {
        await event();
        state = unfinished;

        await watcher.tick();
        await watcher.tick();

        expect(mine()).toHaveLength(1);
    });

    it('sends again once the last has finished and events are still unread', async () => {
        await event();

        await watcher.tick();
        await watcher.tick();

        expect(mine()).toHaveLength(2);
    });

    it('skips a held goal until the hold lapses', async () => {
        await event();
        await goals.holdWake(goal.id, DateTime.now().plus({ minutes: 5 }));

        await watcher.tick();
        expect(mine()).toEqual([]);

        await goals.holdWake(goal.id, DateTime.now().minus({ minutes: 1 }));
        await watcher.tick();
        expect(mine()).toHaveLength(1);
    });

    it('stops at the daily ceiling, and says so once', async () => {
        values.set(ORCHESTRATOR_DAILY_OUTPUT_TOKENS.key, 1_000);
        await new ChatUsageRepository(db).record(goal.threadId, { engine: 'api', model: 'm', usage: { outputTokens: 1_000 } });
        await event();

        await watcher.tick();
        await watcher.tick();

        expect(mine()).toEqual([]);
        expect(logger.warn.mock.calls.filter(([line]) => String(line).includes(project))).toHaveLength(1);
    });

    it('carries on past a goal that fails', async () => {
        await event();
        const eventsAfter = goals.eventsAfter.bind(goals);
        vi.spyOn(goals, 'eventsAfter')
            .mockImplementationOnce(() => Promise.reject(new Error('a dropped connection')))
            .mockImplementation(eventsAfter);

        await expect(watcher.tick()).resolves.toBeUndefined();

        expect(logger.error).toHaveBeenCalled();
    });

    it('logs and survives when goals cannot be read at all', async () => {
        vi.spyOn(goals, 'wakeable').mockRejectedValueOnce(new Error('a dropped connection'));

        await expect(watcher.tick()).resolves.toBeUndefined();

        expect(logger.error).toHaveBeenCalled();
    });

    it('starts once, and stops cleanly whether or not it started', async () => {
        await expect(watcher.stop()).resolves.toBeUndefined();
        watcher.start();
        watcher.start();
        await expect(watcher.stop()).resolves.toBeUndefined();
    });
});
