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
