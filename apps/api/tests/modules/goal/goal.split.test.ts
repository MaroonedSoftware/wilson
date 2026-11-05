import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import type { Card } from '#modules/board/card.js';
import { PostgresBoardRepository } from '#modules/board/postgres.board.repository.js';
import { ChatThreadRepository } from '#modules/chat/chat.thread.repository.js';
import type { DB } from '#modules/data/db.js';
import { EventLog } from '#modules/events/event.log.js';
import { GoalRepository, type Goal } from '#modules/goal/goal.repository.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';

let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

const card = (id: string, splitFrom?: string): Card => ({
    frontmatter: { id, title: `card ${id}`, stage: 'planning', dependsOn: [], retries: {}, ...(splitFrom ? { splitFrom } : {}) },
    sections: {},
    body: 'A plan.',
});

/** A piece stays in its origin's goal, on both paths a split takes through the board. */
describe('a split inside a goal', () => {
    let project: string;
    let board: PostgresBoardRepository;
    let goals: GoalRepository;
    let goal: Goal;

    const idsIn = async (goalId: string) => (await goals.cards(goalId)).map(found => found.id);
    const newGoal = async () =>
        goals.create({ threadId: (await new ChatThreadRepository(db).create('a thread', 'api')).id, project, title: 'Add SSO', outcome: 'o' });

    beforeEach(async () => {
        project = uniqueProject();
        await db.insertInto('wilson.projects').values({ name: project, codeRoot: '/c', worktreeRoot: '/w', runRoot: '/r' }).execute();
        const config = new StaticBoardConfig(project, '/tmp/code', '/tmp/wt', '/tmp/run');
        board = new PostgresBoardRepository(config, db, new EventLog(db, console as never));
        goals = new GoalRepository(db);
        goal = await newGoal();
        await board.create(card('0001'), 'the origin');
    });

    it('keeps a piece an operator split in the goal', async () => {
        await goals.linkCard(goal, '0001');

        await board.create(card('0002', '0001'), 'a piece');

        expect(await idsIn(goal.id)).toEqual(['0001', '0002']);
    });

    it('keeps the pieces of an automatic split in the goal', async () => {
        await goals.linkCard(goal, '0001');

        await board.applySplit('0001', origin => ({
            origin,
            originMessage: 'split',
            pieces: [
                { card: card('0002', '0001'), message: 'a piece' },
                { card: card('0003', '0001'), message: 'a piece' },
            ],
            events: [],
        }));

        expect(await idsIn(goal.id)).toEqual(['0001', '0002', '0003']);
    });

    it('carries a piece of a piece down the line', async () => {
        await goals.linkCard(goal, '0001');

        await board.create(card('0002', '0001'), 'a piece');
        await board.create(card('0003', '0002'), 'a smaller piece');

        expect(await idsIn(goal.id)).toEqual(['0001', '0002', '0003']);
    });

    it('leaves a piece out of any goal when its origin is in none', async () => {
        await board.create(card('0002', '0001'), 'a piece');

        expect(await idsIn(goal.id)).toEqual([]);
    });

    it('writes nothing when the split writes nothing', async () => {
        await goals.linkCard(goal, '0001');

        await expect(
            board.applySplit('0001', origin => ({
                origin,
                originMessage: 'split',
                pieces: [
                    { card: card('0002', '0001'), message: 'a piece' },
                    { card: card('0002', '0001'), message: 'the same id again' },
                ],
                events: [],
            })),
        ).rejects.toThrow();

        expect(await idsIn(goal.id)).toEqual(['0001']);
    });
});
