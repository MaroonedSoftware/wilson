import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { DateTime } from 'luxon';
import { ChatThreadRepository } from '#modules/chat/chat.thread.repository.js';
import { ChatUsageRepository } from '#modules/chat/chat.usage.repository.js';
import type { DB } from '#modules/data/db.js';
import type { CardEventType } from '#modules/events/card.event.js';
import { EventLog } from '#modules/events/event.log.js';
import { GoalRepository } from '#modules/goal/goal.repository.js';
import { testDb } from '#tests/support/test.db.js';

let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

describe('GoalRepository', () => {
    const goals = () => new GoalRepository(db);
    const newThread = async () => (await new ChatThreadRepository(db).create('a thread', 'api')).id;

    /** A registered project of its own, so these tests see only their own rows. */
    const newProject = async (): Promise<string> => {
        const name = `goal-test-${randomUUID()}`;
        await db.insertInto('wilson.projects').values({ name, codeRoot: '/c', worktreeRoot: '/w', runRoot: '/r' }).execute();
        return name;
    };
    const newCard = async (project: string, id: string, title = `card ${id}`) => {
        await db.insertInto('wilson.cards').values({ project, id, title, stage: 'planning', body: '' }).execute();
    };
    const newGoal = async (project: string, title = 'Add SSO') =>
        goals().create({ threadId: await newThread(), project, title, outcome: 'People sign in with SSO' });

    it('creates an active goal and reads it back', async () => {
        const project = await newProject();
        const threadId = await newThread();

        const goal = await goals().create({ threadId, project, title: 'Add SSO', outcome: 'People sign in with SSO' });

        expect(goal).toMatchObject({ threadId, project, title: 'Add SSO', outcome: 'People sign in with SSO', status: 'active' });
        expect(await goals().get(goal.id)).toEqual(goal);
    });

    it('answers undefined for a goal that does not exist', async () => {
        expect(await goals().get('999999999')).toBeUndefined();
        expect(await goals().update('999999999', { status: 'done' })).toBeUndefined();
    });

    it('refuses a second goal on one thread', async () => {
        const project = await newProject();
        const threadId = await newThread();
        await goals().create({ threadId, project, title: 'One', outcome: 'o' });

        await expect(goals().create({ threadId, project, title: 'Two', outcome: 'o' })).rejects.toThrow();
    });

    it('filters by project, status and thread, most recently changed first', async () => {
        const project = await newProject();
        const other = await newProject();
        const first = await newGoal(project, 'First');
        const second = await newGoal(project, 'Second');
        await newGoal(other, 'Elsewhere');
        await goals().update(second.id, { status: 'paused' });
        await goals().update(first.id, { title: 'First again' });

        expect((await goals().list({ project })).map(goal => goal.title)).toEqual(['First again', 'Second']);
        expect((await goals().list({ project, status: 'paused' })).map(goal => goal.id)).toEqual([second.id]);
        expect((await goals().list({ threadId: first.threadId })).map(goal => goal.id)).toEqual([first.id]);
    });

    it('changes only what it is given', async () => {
        const goal = await newGoal(await newProject());

        expect(await goals().update(goal.id, { status: 'done' })).toMatchObject({ status: 'done', title: 'Add SSO' });
        expect(await goals().update(goal.id, {})).toMatchObject({ status: 'done', title: 'Add SSO' });
    });

    describe('wake-ups', () => {
        const eventOn = (project: string, cardId: string, type: CardEventType = 'stage.blocked') =>
            new EventLog(db, console as never).append({ project, cardId, stage: 'testing', type, payload: {} });
        const TYPES: CardEventType[] = ['stage.blocked'];

        it('starts its cursor at the newest event, so it hears nothing from before it existed', async () => {
            const project = await newProject();
            await newCard(project, '0001');
            await eventOn(project, '0001');
            const goal = await newGoal(project);
            await goals().linkCard(goal, '0001');

            expect(await goals().eventsAfter(goal, TYPES, 10)).toEqual([]);
        });

        it("reads only its own cards' events of the given types past its cursor, oldest first, up to a limit", async () => {
            const project = await newProject();
            await newCard(project, '0001');
            await newCard(project, '0002');
            const goal = await newGoal(project);
            await goals().linkCard(goal, '0001');
            await eventOn(project, '0001');
            await eventOn(project, '0002');
            await eventOn(project, '0001', 'stage.failed');
            await eventOn(project, '0001');

            const events = await goals().eventsAfter(goal, TYPES, 10);
            expect(events.map(event => [event.cardId, event.type, event.stage])).toEqual([
                ['0001', 'stage.blocked', 'testing'],
                ['0001', 'stage.blocked', 'testing'],
            ]);
            expect(BigInt(events[0]!.id)).toBeLessThan(BigInt(events[1]!.id));
            expect(await goals().eventsAfter(goal, TYPES, 1)).toHaveLength(1);

            await goals().advanceCursor(goal.id, events[0]!.id);
            expect((await goals().eventsAfter((await goals().get(goal.id))!, TYPES, 10)).map(event => event.id)).toEqual([events[1]!.id]);
        });

        it('offers only active goals on open threads that nothing holds back, and advancing lifts a hold', async () => {
            const project = await newProject();
            const held = await newGoal(project);
            await goals().holdWake(held.id, DateTime.now().plus({ minutes: 5 }));
            const lapsed = await newGoal(project);
            await goals().holdWake(lapsed.id, DateTime.now().minus({ minutes: 5 }));
            const paused = await newGoal(project);
            await goals().update(paused.id, { status: 'paused' });
            const archived = await newGoal(project);
            await new ChatThreadRepository(db).archive(archived.threadId);
            const open = await newGoal(project);

            const offered = (await goals().wakeable()).filter(goal => goal.project === project).map(goal => goal.id);
            expect(offered.sort()).toEqual([lapsed.id, open.id].sort());

            await goals().advanceCursor(held.id, '0');
            expect((await goals().get(held.id))?.wakeHeldUntil).toBeUndefined();
        });

        it("adds up its project's goal threads and no others", async () => {
            const project = await newProject();
            const goal = await newGoal(project);
            const usage = new ChatUsageRepository(db);
            await usage.record(goal.threadId, { engine: 'api', model: 'm', usage: { outputTokens: 100 } });
            await usage.record(goal.threadId, { engine: 'api', model: 'm', usage: { outputTokens: 50 } });
            await usage.record((await newGoal(await newProject())).threadId, { engine: 'api', model: 'm', usage: { outputTokens: 999 } });
            await usage.record(await newThread(), { engine: 'api', model: 'm', usage: { outputTokens: 999 } });

            expect(await goals().outputTokensSince(project, DateTime.now().minus({ minutes: 1 }))).toBe(150);
            expect(await goals().outputTokensSince(project, DateTime.now().plus({ minutes: 1 }))).toBe(0);
        });
    });

    describe('cards', () => {
        it('links cards and lists them, lowest id first', async () => {
            const project = await newProject();
            await newCard(project, '0002', 'The second');
            await newCard(project, '0001', 'The first');
            const goal = await newGoal(project);

            expect(await goals().linkCard(goal, '0002')).toBe('linked');
            expect(await goals().linkCard(goal, '0001')).toBe('linked');

            expect(await goals().cards(goal.id)).toEqual([
                { id: '0001', title: 'The first', stage: 'planning', needsHuman: false },
                { id: '0002', title: 'The second', stage: 'planning', needsHuman: false },
            ]);
        });

        it('treats linking a card twice as linking it once', async () => {
            const project = await newProject();
            await newCard(project, '0001');
            const goal = await newGoal(project);

            await goals().linkCard(goal, '0001');

            expect(await goals().linkCard(goal, '0001')).toBe('linked');
            expect(await goals().cards(goal.id)).toHaveLength(1);
        });

        it('says when a card is missing, and when another goal holds it', async () => {
            const project = await newProject();
            await newCard(project, '0001');
            const holder = await newGoal(project);
            const other = await newGoal(project);
            await goals().linkCard(holder, '0001');

            expect(await goals().linkCard(other, '0404')).toBe('missing');
            expect(await goals().linkCard(other, '0001')).toBe('taken');
            expect(await goals().cards(other.id)).toEqual([]);
        });

        it("refuses another project's card, even with the same id", async () => {
            const project = await newProject();
            const other = await newProject();
            await newCard(other, '0001');
            const goal = await newGoal(project);

            expect(await goals().linkCard(goal, '0001')).toBe('missing');
        });

        it('unlinks a card only from the goal holding it', async () => {
            const project = await newProject();
            await newCard(project, '0001');
            const holder = await newGoal(project);
            const other = await newGoal(project);
            await goals().linkCard(holder, '0001');

            expect(await goals().unlinkCard(other.id, '0001')).toBe(false);
            expect(await goals().unlinkCard(holder.id, '0001')).toBe(true);
            expect(await goals().cards(holder.id)).toEqual([]);
        });
    });
});
