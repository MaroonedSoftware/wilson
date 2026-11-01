import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { Duration } from 'luxon';
import { ChatQuestionRepository, type NewPendingQuestion } from '#modules/chat/chat.question.repository.js';
import type { AskedQuestion } from '#modules/chat/chat.questions.js';
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
 * The agent never learns an answer except through the person's own submission: a question is a
 * pending row, and only `answer` moves it. What these pin is that an answer is taken at most once —
 * two racing submissions must not both win — and that an expired question cannot be answered.
 */
describe('ChatQuestionRepository', () => {
    const questions = () => new ChatQuestionRepository(db);
    const newThread = async () => (await new ChatThreadRepository(db).create('a thread', 'api')).id;
    const database: AskedQuestion = {
        header: 'Database',
        text: 'Which database should this project use?',
        options: [
            { label: 'Postgres', description: 'The default for this repo.' },
            { label: 'SQLite', description: 'Simpler, file-based.' },
        ],
        multiSelect: false,
    };
    const asked: NewPendingQuestion = {
        questions: [database],
        expiresIn: Duration.fromObject({ minutes: 10 }),
    };

    it('stores a question as pending, with its questions intact', async () => {
        const thread = await newThread();

        const question = await questions().ask(thread, asked);

        expect(question).toMatchObject({ threadId: thread, questions: [database], status: 'pending', decidedAt: undefined, answers: undefined });
        expect(await questions().get(question.id)).toEqual(question);
    });

    it('answers a pending question once, and refuses every later answer', async () => {
        const question = await questions().ask(await newThread(), asked);

        const answered = await questions().answer(question.id, [{ chosen: [0] }]);

        expect(answered).toMatchObject({ status: 'answered', answers: [{ chosen: [0] }] });
        expect(answered?.decidedAt).toBeDefined();
        expect(await questions().answer(question.id, [{ chosen: [1] }])).toBeUndefined();
    });

    it('lets exactly one of several racing answers win', async () => {
        const question = await questions().ask(await newThread(), asked);

        const results = await Promise.all(Array.from({ length: 5 }, () => questions().answer(question.id, [{ chosen: [0] }])));

        expect(results.filter(result => result !== undefined)).toHaveLength(1);
    });

    it('refuses to answer an expired question, and leaves it pending', async () => {
        const question = await questions().ask(await newThread(), { ...asked, expiresIn: Duration.fromObject({ seconds: -1 }) });

        expect(await questions().answer(question.id, [{ chosen: [0] }])).toBeUndefined();
        expect((await questions().get(question.id))?.status).toBe('pending');
    });

    it("dismisses a thread's pending questions, leaves an answered one alone, and touches no other thread", async () => {
        const thread = await newThread();
        const other = await newThread();
        const pending = await questions().ask(thread, asked);
        const toAnswer = await questions().ask(thread, asked);
        const answered = await questions().answer(toAnswer.id, [{ chosen: [0] }]);
        const elsewhere = await questions().ask(other, asked);

        const dismissed = await questions().dismissPending(thread);

        expect(dismissed.map(question => question.id)).toEqual([pending.id]);
        expect((await questions().get(pending.id))?.status).toBe('dismissed');
        expect((await questions().get(toAnswer.id))?.status).toBe('answered');
        expect((await questions().get(toAnswer.id))?.decidedAt).toEqual(answered?.decidedAt);
        expect((await questions().get(elsewhere.id))?.status).toBe('pending');
    });

    it("lists a thread's questions oldest first, and no other thread's", async () => {
        const thread = await newThread();
        const first = await questions().ask(thread, asked);
        await questions().ask(await newThread(), asked);
        const second = await questions().ask(thread, asked);

        expect((await questions().forThread(thread)).map(question => question.id)).toEqual([first.id, second.id]);
    });
});
