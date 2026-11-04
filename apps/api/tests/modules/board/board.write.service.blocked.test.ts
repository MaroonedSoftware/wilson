import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { JobBroker } from '@maroonedsoftware/jobbroker';
import type { Logger } from '@maroonedsoftware/logger';
import type { Kysely } from 'kysely';
import { BoardWriteService } from '#modules/board/board.write.service.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { blockedRetryKey, type Card, type CardBlocked } from '#modules/board/card.js';
import { PostgresBoardRepository } from '#modules/board/postgres.board.repository.js';
import type { DB } from '#modules/data/db.js';
import { EventLog } from '#modules/events/event.log.js';
import { CardJobs } from '#modules/jobs/card.jobs.js';
import { RunningCards } from '#modules/jobs/running.cards.js';
import type { SettingsStore } from '#modules/settings/settings.store.js';
import { StaticStageConfigStore } from '#modules/stages/stage.config.store.js';
import { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';

const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() } as unknown as Logger;

const stageConfigs = new StaticStageConfigStore(
    [
        'stages:',
        '  - name: implementing',
        '    mode: agent',
        '    model: claude-opus',
        '    instructions: build it',
        '    onPass: testing',
        '    onFail: implementing',
        '  - name: testing',
        '    mode: agent',
        '    model: claude-opus',
        '    instructions: test the thing',
        '    onPass: merged',
        '    onFail: implementing',
        '',
    ].join('\n'),
);

const blocked: CardBlocked = {
    category: 'decision',
    tried: 'read the plan and the existing callers',
    question: 'Should the old endpoint keep working?',
    options: ['keep it', 'remove it'],
    stage: 'implementing',
    askedAt: '2026-11-04T09:00:00.000Z',
};

const parked = (id: string, overrides: Partial<Card['frontmatter']> = {}, body = '## Goal\n\nDo it.\n'): Card => ({
    frontmatter: {
        id,
        title: `card ${id}`,
        stage: 'implementing',
        dependsOn: [],
        retries: { implementing: 2, [blockedRetryKey('implementing')]: 1 },
        needsHuman: true,
        needsHumanReason: blocked.question,
        blocked,
        ...overrides,
    },
    sections: {},
    body,
});

/** `create` writes only what a new card can have, so the question and retries go on with a write. */
const seed = async (board: PostgresBoardRepository, card: Card): Promise<void> => {
    await board.create(card, 'seed');
    await board.write(card.frontmatter.id, 'park', current => ({ ...current, frontmatter: card.frontmatter }));
};

let db: Kysely<DB>;

beforeAll(async () => {
    db = testDb();
});

afterAll(async () => {
    await db.destroy();
});

const freshBoard = () => {
    const project = uniqueProject();
    const config = new StaticBoardConfig(project, '/tmp/code', '/tmp/wt', '/tmp/run');
    const events = { append: vi.fn(async () => {}) } as unknown as EventLog;
    const board = new PostgresBoardRepository(config, db, events);
    const worktrees = {
        reclaim: vi.fn(async () => {}),
        branchName: vi.fn((cardId: string, title: string) => `card/${cardId}-${title}`),
        hasWork: vi.fn(async () => false),
    } as unknown as WorktreeManager;
    const service = new BoardWriteService(
        board,
        config,
        worktrees,
        events,
        logger,
        { inFlight: vi.fn(async () => undefined), record: vi.fn(), clear: vi.fn() } as unknown as CardJobs,
        { send: vi.fn(), getJob: vi.fn(), cancel: vi.fn() } as unknown as JobBroker,
        new RunningCards(),
        { get: vi.fn() } as unknown as SettingsStore,
        stageConfigs,
    );
    return { project, board, events, service };
};

describe('the blocked column', () => {
    it('round-trips through the repository and onto the wire', async () => {
        const { board, service } = freshBoard();
        await seed(board, parked('0100'));

        expect((await board.read('0100')).frontmatter.blocked).toEqual(blocked);

        const detail = await service.rename('0100', { title: 'card 0100' });
        expect(detail.blocked?.question).toBe(blocked.question);
        expect(detail.blocked?.askedAt.toUTC().toISO()).toBe(blocked.askedAt);
    });

    it('reads as absent on a card that never asked', async () => {
        const { board } = freshBoard();
        await seed(board, parked('0101', { needsHuman: false, needsHumanReason: undefined, blocked: undefined }));

        expect((await board.read('0101')).frontmatter.blocked).toBeUndefined();
    });

    it("goes with an ack, which also gives back the stage's question count", async () => {
        const { board, service } = freshBoard();
        await seed(board, parked('0102', { retries: { implementing: 2, 'implementing:blocked': 1, testing: 1 } }));

        const detail = await service.ack('0102');

        expect(detail.needsHuman).toBe(false);
        expect(detail.blocked).toBeUndefined();
        const { frontmatter } = await board.read('0102');
        expect(frontmatter.blocked).toBeUndefined();
        expect(frontmatter.retries).toEqual({ testing: 1 });
    });

    it('goes with a move, even one to the stage the card is already in', async () => {
        const { board, service } = freshBoard();
        await seed(board, parked('0103'));

        const detail = await service.move('0103', { stage: 'implementing' });

        expect(detail.blocked).toBeUndefined();
        expect((await board.read('0103')).frontmatter.blocked).toBeUndefined();
    });

    it('goes when any writer ends the card', async () => {
        const { board } = freshBoard();
        await seed(board, parked('0104'));

        await board.write('0104', 'end it', current => ({ ...current, frontmatter: { ...current.frontmatter, stage: 'dropped' } }));

        expect((await board.read('0104')).frontmatter.blocked).toBeUndefined();
    });
});

describe('answer', () => {
    it('writes the answer into the plan, clears the flag and keeps retries', async () => {
        const { board, events, service } = freshBoard();
        const retries = { implementing: 2, 'implementing:blocked': 1 };
        await seed(board, parked('0110', { retries }));

        const detail = await service.answer('0110', { answer: 'Keep it for one release.' });

        expect(detail.needsHuman).toBe(false);
        expect(detail.needsHumanReason).toBeUndefined();
        expect(detail.blocked).toBeUndefined();
        expect(detail.body).toContain('## Operator answer');
        expect(detail.body).toContain(`> ${blocked.question}`);
        expect(detail.body).toContain('> Keep it for one release.');

        const { frontmatter } = await board.read('0110');
        expect(frontmatter.retries).toEqual(retries);
        expect(frontmatter.stage).toBe('implementing');
        expect(events.append).toHaveBeenCalledWith(
            expect.objectContaining({
                cardId: '0110',
                type: 'card.answered',
                payload: { stage: 'implementing', answer: 'Keep it for one release.', question: blocked.question, by: 'human' },
            }),
            expect.anything(),
        );
    });

    it("names the stopped run's preserved patch in the section", async () => {
        const { board, service } = freshBoard();
        await seed(board, parked('0111', { blocked: { ...blocked, patchPath: '/run/cards/0111/last-failed-attempt.patch' } }));

        const detail = await service.answer('0111', { answer: 'Yes.' });

        expect(detail.body).toContain('`/run/cards/0111/last-failed-attempt.patch`');
    });

    it('moves a pinned plan past the answer, so the next run reads it', async () => {
        const { board, service } = freshBoard();
        await seed(board, parked('0112'));
        const pin = await board.currentVersion('0112');
        await board.write('0112', 'pin', current => ({ ...current, frontmatter: { ...current.frontmatter, planVersionId: pin } }));

        await service.answer('0112', { answer: 'Keep it.' });

        const { frontmatter } = await board.read('0112');
        expect(frontmatter.planVersionId).not.toBe(pin);
        expect((await board.readAt('0112', frontmatter.planVersionId!)).body).toContain('> Keep it.');
    });

    it('leaves an unpinned card unpinned', async () => {
        const { board, service } = freshBoard();
        await seed(board, parked('0113'));

        await service.answer('0113', { answer: 'Keep it.' });

        expect((await board.read('0113')).frontmatter.planVersionId).toBeUndefined();
    });

    it('takes the question from the head row, not the pinned plan', async () => {
        const { board, service } = freshBoard();
        await board.create(parked('0114', { needsHuman: false, needsHumanReason: undefined, blocked: undefined }), 'seed');
        const pin = await board.currentVersion('0114');
        await board.write('0114', 'pin', current => ({ ...current, frontmatter: { ...current.frontmatter, planVersionId: pin } }));
        // Asked after the pin, so the pinned version has never heard of it.
        await board.write('0114', 'park', current => ({
            ...current,
            frontmatter: { ...current.frontmatter, needsHuman: true, needsHumanReason: blocked.question, blocked },
        }));

        const detail = await service.answer('0114', { answer: 'Keep it.' });

        expect(detail.body).toContain(`> ${blocked.question}`);
    });

    it('refuses a card flagged for any other reason, writing nothing', async () => {
        const { board, service } = freshBoard();
        await seed(board, parked('0115', { blocked: undefined, needsHumanReason: 'failed 3 times' }));
        const version = await board.currentVersion('0115');

        await expect(service.answer('0115', { answer: 'Keep it.' })).rejects.toMatchObject({
            statusCode: 400,
            details: { reason: '0115 has no question waiting for an answer' },
        });

        expect(await board.currentVersion('0115')).toBe(version);
        expect((await board.read('0115')).frontmatter.needsHuman).toBe(true);
    });

    it('refuses a second answer', async () => {
        const { board, service } = freshBoard();
        await seed(board, parked('0116'));

        await service.answer('0116', { answer: 'Keep it.' });

        await expect(service.answer('0116', { answer: 'Remove it.' })).rejects.toMatchObject({ statusCode: 400 });
        expect((await board.read('0116')).body).not.toContain('Remove it.');
    });

    it('refuses an empty answer, writing nothing', async () => {
        const { board, service } = freshBoard();
        await seed(board, parked('0117'));
        const version = await board.currentVersion('0117');

        await expect(service.answer('0117', { answer: '   ' })).rejects.toMatchObject({ statusCode: 400 });

        expect(await board.currentVersion('0117')).toBe(version);
    });

    it('answers 404 for no such card', async () => {
        const { service } = freshBoard();

        await expect(service.answer('nope', { answer: 'Keep it.' })).rejects.toMatchObject({ statusCode: 404 });
    });
});
