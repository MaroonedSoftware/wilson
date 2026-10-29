import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { Duration } from 'luxon';
import { ChatPendingActionRepository, type NewPendingAction } from '#modules/chat/chat.pending.action.repository.js';
import { ChatThreadRepository } from '#modules/chat/chat.thread.repository.js';
import type { DB } from '#modules/data/db.js';
import { testDb } from '#tests/support/test.db.js';

let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

/**
 * The agent never changes anything itself: a change is a pending action, and only the person's
 * decision runs it. What these pin is that a decision is taken at most once — a double-clicked
 * confirm must not run an operation twice — and that an expired proposal cannot be confirmed.
 */
describe('ChatPendingActionRepository', () => {
    const actions = () => new ChatPendingActionRepository(db);
    const newThread = async () => (await new ChatThreadRepository(db).create('a thread', 'api')).id;
    const moveCard: NewPendingAction = {
        project: 'wilson',
        operation: 'move_card',
        arguments: { id: '0007', body: { stage: 'implementing' } },
        summary: 'Move 0007 to implementing',
        expiresIn: Duration.fromObject({ minutes: 10 }),
    };

    it('stores a proposal as pending, with its operation and exact arguments', async () => {
        const thread = await newThread();

        const action = await actions().propose(thread, moveCard);

        expect(action).toMatchObject({
            threadId: thread,
            project: 'wilson',
            operation: 'move_card',
            arguments: { id: '0007', body: { stage: 'implementing' } },
            summary: 'Move 0007 to implementing',
            status: 'pending',
            decidedAt: undefined,
        });
        expect(await actions().get(action.id)).toEqual(action);
    });

    it('keeps no project for an operation that names none', async () => {
        const action = await actions().propose(await newThread(), { ...moveCard, project: undefined, operation: 'register_project' });

        expect(action.project).toBeUndefined();
    });

    it('claims a pending action once, and refuses every later claim', async () => {
        const action = await actions().propose(await newThread(), moveCard);

        const claimed = await actions().claim(action.id);

        expect(claimed).toMatchObject({ status: 'running' });
        expect(claimed?.decidedAt).toBeDefined();
        expect(await actions().claim(action.id)).toBeUndefined();
    });

    it('lets exactly one of several racing confirms win', async () => {
        const action = await actions().propose(await newThread(), moveCard);

        const results = await Promise.all(Array.from({ length: 5 }, () => actions().claim(action.id)));

        expect(results.filter(result => result !== undefined)).toHaveLength(1);
    });

    it('declines a pending action, after which it cannot be confirmed', async () => {
        const action = await actions().propose(await newThread(), moveCard);

        expect(await actions().decline(action.id)).toMatchObject({ status: 'declined' });
        expect(await actions().claim(action.id)).toBeUndefined();
    });

    it('cannot decline an action already confirmed', async () => {
        const action = await actions().propose(await newThread(), moveCard);
        await actions().claim(action.id);

        expect(await actions().decline(action.id)).toBeUndefined();
    });

    it('refuses to confirm or decline an expired proposal, and leaves it pending', async () => {
        const action = await actions().propose(await newThread(), { ...moveCard, expiresIn: Duration.fromObject({ seconds: -1 }) });

        expect(await actions().claim(action.id)).toBeUndefined();
        expect(await actions().decline(action.id)).toBeUndefined();
        expect((await actions().get(action.id))?.status).toBe('pending');
    });

    it("records a claimed action's result, or why it failed", async () => {
        const thread = await newThread();
        const succeeded = await actions().propose(thread, moveCard);
        const failed = await actions().propose(thread, moveCard);
        await actions().claim(succeeded.id);
        await actions().claim(failed.id);

        expect(await actions().finish(succeeded.id, { result: { id: '0007', stage: 'implementing' } })).toMatchObject({
            status: 'done',
            result: { id: '0007', stage: 'implementing' },
        });
        expect(await actions().finish(failed.id, { error: 'card 0007 is not in planning' })).toMatchObject({
            status: 'failed',
            error: 'card 0007 is not in planning',
        });
    });

    it('finishes only an action that is running', async () => {
        const action = await actions().propose(await newThread(), moveCard);

        expect(await actions().finish(action.id, { result: {} })).toBeUndefined();
        expect((await actions().get(action.id))?.status).toBe('pending');
    });

    it("lists a thread's actions oldest first, and no other thread's", async () => {
        const thread = await newThread();
        const first = await actions().propose(thread, moveCard);
        await actions().propose(await newThread(), moveCard);
        const second = await actions().propose(thread, { ...moveCard, summary: 'Move 0008 to implementing' });

        expect((await actions().forThread(thread)).map(action => action.id)).toEqual([first.id, second.id]);
    });
});
