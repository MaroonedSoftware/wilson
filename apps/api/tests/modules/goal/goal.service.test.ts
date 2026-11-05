import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { ProjectRepository } from '#modules/board/project.repository.js';
import { ChatThreadRepository } from '#modules/chat/chat.thread.repository.js';
import type { DB } from '#modules/data/db.js';
import { GoalRepository } from '#modules/goal/goal.repository.js';
import { GoalService } from '#modules/goal/goal.service.js';
import { testDb } from '#tests/support/test.db.js';

let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

const refusal = (statusCode: number, reason: string | RegExp) =>
    expect.objectContaining({
        statusCode,
        details: expect.objectContaining({ reason: typeof reason === 'string' ? reason : expect.stringMatching(reason) }),
    });

describe('GoalService', () => {
    const service = () => new GoalService(new GoalRepository(db), new ChatThreadRepository(db), new ProjectRepository(db));
    const threads = () => new ChatThreadRepository(db);
    const newThread = async () => (await threads().create('a thread', 'api')).id;
    const newProject = async (): Promise<string> => {
        const name = `goal-test-${randomUUID()}`;
        await db.insertInto('wilson.projects').values({ name, codeRoot: '/c', worktreeRoot: '/w', runRoot: '/r' }).execute();
        return name;
    };
    const newCard = (project: string, id: string) =>
        db
            .insertInto('wilson.cards')
            .values({ project, id, title: `card ${id}`, stage: 'planning', body: '' })
            .execute();
    const newGoal = async (project: string) =>
        service().create({ threadId: await newThread(), project, title: 'Add SSO', outcome: 'People sign in with SSO' });

    describe('create', () => {
        it('starts an active goal, trimming what it was given', async () => {
            const project = await newProject();
            const threadId = await newThread();

            const goal = await service().create({ threadId, project, title: '  Add SSO ', outcome: ' People sign in ' });

            expect(goal).toMatchObject({ threadId, project, title: 'Add SSO', outcome: 'People sign in', status: 'active' });
        });

        it('refuses a blank title or outcome', async () => {
            const project = await newProject();
            const threadId = await newThread();

            await expect(service().create({ threadId, project, title: ' ', outcome: 'o' })).rejects.toEqual(refusal(400, 'a goal needs a title'));
            await expect(service().create({ threadId, project, title: 't', outcome: ' ' })).rejects.toEqual(refusal(400, 'a goal needs an outcome'));
        });

        it('refuses a thread or project that does not exist', async () => {
            const project = await newProject();

            await expect(service().create({ threadId: '999999999', project, title: 't', outcome: 'o' })).rejects.toEqual(refusal(404, /not found/));
            await expect(service().create({ threadId: 'not-a-number', project, title: 't', outcome: 'o' })).rejects.toEqual(
                refusal(404, /not found/),
            );
            await expect(service().create({ threadId: await newThread(), project: 'nope', title: 't', outcome: 'o' })).rejects.toEqual(
                refusal(400, /not registered/),
            );
        });

        it('refuses an archived thread, and one that already has a goal', async () => {
            const project = await newProject();
            const archived = await newThread();
            await threads().archive(archived);
            const goal = await newGoal(project);

            await expect(service().create({ threadId: archived, project, title: 't', outcome: 'o' })).rejects.toEqual(refusal(400, /archived/));
            await expect(service().create({ threadId: goal.threadId, project, title: 't', outcome: 'o' })).rejects.toEqual(
                refusal(409, `chat thread ${goal.threadId} already has goal ${goal.id}`),
            );
        });
    });

    it('lists by thread, and answers nothing for an id that could not be one', async () => {
        const goal = await newGoal(await newProject());

        expect((await service().list({ threadId: goal.threadId })).map(found => found.id)).toEqual([goal.id]);
        expect(await service().list({ threadId: 'not-a-number' })).toEqual([]);
    });

    it('answers 404 for a goal that does not exist, whatever the id looks like', async () => {
        await expect(service().get('999999999')).rejects.toEqual(refusal(404, 'goal 999999999 not found'));
        await expect(service().get('not-a-number')).rejects.toEqual(refusal(404, 'goal not-a-number not found'));
        await expect(service().update('999999999', { status: 'done' })).rejects.toEqual(refusal(404, /not found/));
    });

    it('updates only what it was given, and refuses to blank a title', async () => {
        const goal = await newGoal(await newProject());

        expect(await service().update(goal.id, { status: 'paused' })).toMatchObject({ status: 'paused', title: 'Add SSO' });
        await expect(service().update(goal.id, { title: '  ' })).rejects.toEqual(refusal(400, 'a goal needs a title'));
    });

    describe('cards', () => {
        it('adds a card and shows it on the goal, then removes it', async () => {
            const project = await newProject();
            await newCard(project, '0001');
            const goal = await newGoal(project);

            const added = await service().addCard(goal.id, '0001');
            expect(added.cards).toEqual([{ id: '0001', title: 'card 0001', stage: 'planning', needsHuman: false }]);
            expect((await service().get(goal.id)).cards).toHaveLength(1);

            expect((await service().removeCard(goal.id, '0001')).cards).toEqual([]);
        });

        it('says why a card cannot be added or removed', async () => {
            const project = await newProject();
            await newCard(project, '0001');
            const holder = await newGoal(project);
            const other = await newGoal(project);
            await service().addCard(holder.id, '0001');

            await expect(service().addCard(other.id, '0404')).rejects.toEqual(refusal(404, `card 0404 not found in project "${project}"`));
            await expect(service().addCard(other.id, '0001')).rejects.toEqual(refusal(409, 'card 0001 is already in another goal'));
            await expect(service().removeCard(other.id, '0001')).rejects.toEqual(refusal(404, `card 0001 is not in goal ${other.id}`));
        });
    });
});
