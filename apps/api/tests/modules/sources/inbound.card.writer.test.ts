import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';
import type { Logger } from '@maroonedsoftware/logger';
import type { JobBroker } from '@maroonedsoftware/jobbroker';
import { InboundCardWriter } from '#modules/sources/inbound.card.writer.js';
import type { CardSourceItem } from '#modules/sources/card.source.js';
import { BoardWriteService } from '#modules/board/board.write.service.js';
import { PostgresBoardRepository } from '#modules/board/postgres.board.repository.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { CardJobs } from '#modules/jobs/card.jobs.js';
import { RunningCards } from '#modules/jobs/running.cards.js';
import { StaticStageConfigStore } from '#modules/stages/stage.config.store.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';
import type { EventLog } from '#modules/events/event.log.js';
import type { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import type { SettingsStore } from '#modules/settings/settings.store.js';
import type { DB } from '#modules/data/db.js';

let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

const fakeLogger = (): Logger =>
    ({
        warn: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
    }) as unknown as Logger;

/**
 * A fresh project + `InboundCardWriter`, wired against a real `PostgresBoardRepository` on the test
 * db and a real `BoardWriteService` — the same idiom `board.write.service.test.ts`'s own `freshBoard`
 * uses, unique per project so no test shares a board with another. Everything `BoardWriteService`
 * takes beyond `board`/`config`/`worktrees` is a double or a real lightweight collaborator: `apply`'s
 * two paths (`createFromSource`, then `rename`/`edit` on a second report) never reach the job queue,
 * the event log, or stage config, so those only need to satisfy the constructor, not do anything.
 * `worktrees` answers `hasWork` (which `rename` checks) `false` — a card fresh out of `createFromSource`
 * has no branch anything could have worked on yet.
 */
const freshWriter = () => {
    const events = { append: vi.fn(async () => {}) };
    const config = new StaticBoardConfig(uniqueProject(), '/tmp/code', '/tmp/wt', '/tmp/run');
    const board = new PostgresBoardRepository(config, db, events as unknown as EventLog);
    const worktrees = {
        branchName: vi.fn((cardId: string, title: string) => `card/${cardId}-${title}`),
        hasWork: vi.fn(async () => false),
        reclaim: vi.fn(async () => {}),
    };
    const broker = { send: vi.fn(async () => 'job-1'), cancel: vi.fn(async () => {}), getJob: vi.fn(async () => null) };
    const cardJobs = new CardJobs(config, db, broker as unknown as JobBroker);
    const boardWriteService = new BoardWriteService(
        board,
        config,
        worktrees as unknown as WorktreeManager,
        events as unknown as EventLog,
        fakeLogger(),
        cardJobs,
        broker as unknown as JobBroker,
        new RunningCards(),
        undefined as unknown as SettingsStore,
        new StaticStageConfigStore(),
    );
    const writer = new InboundCardWriter(boardWriteService, board);
    return { board, writer };
};

const item = (overrides: Partial<CardSourceItem> = {}): CardSourceItem => ({
    externalId: 'ENG-1',
    title: 'Fix the thing',
    body: 'It is broken.',
    ...overrides,
});

describe('InboundCardWriter', () => {
    it('creates a card in parking-lot with the external ref recorded, on the first report', async () => {
        const { board, writer } = freshWriter();

        await writer.apply('linear', item());

        const cards = await board.list();
        expect(cards).toHaveLength(1);
        expect(cards[0]!.frontmatter.stage).toBe('parking-lot');
        expect(cards[0]!.frontmatter.title).toBe('Fix the thing');
        expect(cards[0]!.body).toBe('It is broken.');
        expect(cards[0]!.frontmatter.external).toEqual({ linear: 'ENG-1' });
    });

    it("updates the existing card's title and body on a second report carrying the same external ref, gaining the board no second card", async () => {
        const { board, writer } = freshWriter();
        await writer.apply('linear', item());

        await writer.apply('linear', item({ title: 'Fix the thing (updated)', body: 'Turns out it was worse.' }));

        const cards = await board.list();
        expect(cards).toHaveLength(1);
        expect(cards[0]!.frontmatter.title).toBe('Fix the thing (updated)');
        expect(cards[0]!.body).toBe('Turns out it was worse.');
        expect(cards[0]!.frontmatter.external).toEqual({ linear: 'ENG-1' });
    });

    it('does not confuse the same external id reported under two different sources', async () => {
        const { board, writer } = freshWriter();
        await writer.apply('linear', item({ externalId: 'SHARED-1', title: 'Linear title' }));

        await writer.apply('github', item({ externalId: 'SHARED-1', title: 'GitHub title' }));

        const cards = await board.list();
        expect(cards).toHaveLength(2);
        expect(cards.map(c => c.frontmatter.title).sort()).toEqual(['GitHub title', 'Linear title']);
        expect(cards.map(c => c.frontmatter.external)).toEqual(
            expect.arrayContaining([{ linear: 'SHARED-1' }, { github: 'SHARED-1' }]),
        );
    });

    it('leaves other cards alone and creates a new one when a report names an external id not yet on the board', async () => {
        const { board, writer } = freshWriter();
        await writer.apply('linear', item({ externalId: 'ENG-1', title: 'First' }));

        await writer.apply('linear', item({ externalId: 'ENG-2', title: 'Second' }));

        const cards = await board.list();
        expect(cards).toHaveLength(2);
        expect(cards.map(c => c.frontmatter.title).sort()).toEqual(['First', 'Second']);
    });

    it('exposes no way to set stage, branch, or retries: forcing them onto a reported item through an unsafe cast still leaves them untouched', async () => {
        const { board, writer } = freshWriter();
        // `CardSourceItem` carries only `externalId`, `title`, and `body` — this cast is the only way
        // to even attempt handing `apply` a `stage`/`branch`/`retries`, and it proves the class reads
        // none of them: nothing it writes to the board carries them, not merely that a validator
        // would have refused them.
        const smuggled = {
            externalId: 'ENG-1',
            title: 'Title',
            body: 'Body',
            stage: 'merged',
            branch: 'evil-branch',
            retries: { implementing: 99 },
        } as unknown as CardSourceItem;

        await writer.apply('linear', smuggled);

        const [created] = await board.list();
        expect(created!.frontmatter.stage).toBe('parking-lot');
        expect(created!.frontmatter.branch).toBeUndefined();
        expect(created!.frontmatter.retries).toEqual({});
    });
});
