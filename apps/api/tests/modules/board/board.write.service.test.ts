import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@maroonedsoftware/logger';
import { BoardWriteService } from '#modules/board/board.write.service.js';
import { PostgresBoardRepository } from '#modules/board/postgres.board.repository.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { EventLog } from '#modules/events/event.log.js';
import { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';
import type { Card } from '#modules/board/card.js';
import type { Kysely } from 'kysely';
import type { DB } from '#modules/data/db.js';

const card = (id: string, overrides: Partial<Card['frontmatter']> = {}): Card => ({
    frontmatter: { id, title: `card ${id}`, stage: 'implementing', dependsOn: [], retries: {}, ...overrides },
    sections: {},
    body: 'body text',
});

const fakeLogger = (): Logger & { warn: ReturnType<typeof vi.fn> } =>
    ({
        warn: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
    }) as unknown as Logger & { warn: ReturnType<typeof vi.fn> };

let db: Kysely<DB>;
let boardRoot: string;

beforeAll(async () => {
    db = testDb();

    const base = await mkdtemp(join(tmpdir(), 'board-write-service-'));
    boardRoot = join(base, 'board');
    await mkdir(join(boardRoot, 'config'), { recursive: true });
    await writeFile(
        join(boardRoot, 'config', 'stages.yaml'),
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
        'utf8',
    );
});

afterAll(async () => {
    await db.destroy();
});

/**
 * A fresh project + board repository + write service for one test, isolated from every other by a
 * unique project name — the same idiom `move.command.test.ts` uses for the CLI command this service
 * ports its behaviour from, so a divergence between the two shows up as a divergence in behaviour,
 * not in how the two test files are wired up.
 */
const freshBoard = (worktrees: { reclaim: ReturnType<typeof vi.fn> } = { reclaim: vi.fn(async () => {}) }) => {
    const events = { append: vi.fn(async () => {}) };
    const config = new StaticBoardConfig(uniqueProject(), boardRoot, '/tmp/code', '/tmp/wt', '/tmp/run');
    const board = new PostgresBoardRepository(config, db, events as unknown as EventLog);
    const logger = fakeLogger();
    const service = new BoardWriteService(board, config, worktrees as unknown as WorktreeManager, events as unknown as EventLog, logger);
    return { board, config, events, worktrees, logger, service };
};

describe('BoardWriteService', () => {
    describe('create', () => {
        it('assigns the next sequential id and defaults an unset stage to parking-lot, exactly like `wilson card create`', async () => {
            const { board, service } = freshBoard();
            await board.create(card('0001', { stage: 'implementing' }), 'seed');

            const detail = await service.create({ title: 'Ship the thing', body: 'the plan' });

            expect(detail.id).toBe('0002');
            expect(detail.stage).toBe('parking-lot');
            expect(detail.title).toBe('Ship the thing');
            expect(detail.body).toBe('the plan');

            const stored = await board.read('0002');
            expect(stored.frontmatter.stage).toBe('parking-lot');
            expect(stored.frontmatter.title).toBe('Ship the thing');
            expect(stored.body).toBe('the plan');
        });

        it('creates in the requested stage when one is given, rather than always parking-lot', async () => {
            const { board, service } = freshBoard();

            const detail = await service.create({ title: 'Straight to work', stage: 'implementing', body: 'go' });

            expect(detail.stage).toBe('implementing');
            const stored = await board.read(detail.id);
            expect(stored.frontmatter.stage).toBe('implementing');
        });

        it('records the same version message the CLI records: "Create {id}: {title}"', async () => {
            const { board, service } = freshBoard();

            const detail = await service.create({ title: 'Traceable card', body: 'x' });

            const versions = await board.versions(detail.id, 10);
            expect(versions).toHaveLength(1);
            expect(versions[0].message).toBe(`Create ${detail.id}: Traceable card`);
        });

        it('starts on the next id over the highest one already on the board, not just count + 1', async () => {
            const { board, service } = freshBoard();
            await board.create(card('0001'), 'seed');
            await board.create(card('0007'), 'seed');

            const detail = await service.create({ title: 'Next after 0007', body: 'x' });

            expect(detail.id).toBe('0008');
        });
    });

    describe('move', () => {
        it('refuses a target the stage graph does not define with a 400 carrying the same reason `wilson card move` reports', async () => {
            const { board, service } = freshBoard();
            await board.create(card('0001', { stage: 'implementing' }), 'seed');

            await expect(service.move('0001', { stage: 'nowhere' })).rejects.toMatchObject({
                statusCode: 400,
                details: { reason: expect.stringContaining('"nowhere" is not a state this board defines') },
            });

            // The refusal must not have moved the card.
            const stored = await board.read('0001');
            expect(stored.frontmatter.stage).toBe('implementing');
        });

        it('answers a card that does not exist with a 404, matching getById', async () => {
            const { service } = freshBoard();

            await expect(service.move('missing', { stage: 'testing' })).rejects.toMatchObject({ statusCode: 404 });
        });

        it('moves a card to a new stage, writing the transition event with by: human', async () => {
            const { board, events, service } = freshBoard();
            await board.create(card('0002', { stage: 'implementing' }), 'seed');

            const detail = await service.move('0002', { stage: 'testing' });

            expect(detail.stage).toBe('testing');
            const stored = await board.read('0002');
            expect(stored.frontmatter.stage).toBe('testing');
            expect(events.append).toHaveBeenCalledWith(
                expect.objectContaining({
                    cardId: '0002',
                    type: 'transition.written',
                    payload: { from: 'implementing', to: 'testing', by: 'human' },
                }),
                expect.anything(),
            );
        });

        it("clears a flagged card's needsHuman fields on an ordinary move to a different stage", async () => {
            const { board, service } = freshBoard();
            await board.create(card('0003', { stage: 'implementing', needsHuman: true, needsHumanReason: 'stuck' }), 'seed');

            const detail = await service.move('0003', { stage: 'testing' });

            expect(detail.needsHuman).toBe(false);
            expect(detail.needsHumanReason).toBeUndefined();
            const stored = await board.read('0003');
            expect(stored.frontmatter.needsHuman).toBe(false);
            expect(stored.frontmatter.needsHumanReason).toBeUndefined();
        });

        it('clears the flag even when the target is the stage the card is already in, instead of taking the no-op path', async () => {
            const { board, events, service } = freshBoard();
            await board.create(card('0004', { stage: 'implementing', needsHuman: true, needsHumanReason: 'stuck' }), 'seed');
            const versionBefore = await board.currentVersion('0004');

            const detail = await service.move('0004', { stage: 'implementing' });

            expect(detail.stage).toBe('implementing');
            expect(detail.needsHuman).toBe(false);
            // Actually wrote a new version — this did not take the bare "already in stage" no-op path.
            expect(await board.currentVersion('0004')).not.toBe(versionBefore);
            expect(events.append).toHaveBeenCalledWith(expect.objectContaining({ type: 'transition.written' }), expect.anything());
        });

        it('stays a true no-op — no write, no event — when the card is already in the target stage and carries no flag', async () => {
            const { board, events, service } = freshBoard();
            await board.create(card('0005', { stage: 'implementing' }), 'seed');
            const versionBefore = await board.currentVersion('0005');

            const detail = await service.move('0005', { stage: 'implementing' });

            expect(detail.stage).toBe('implementing');
            expect(await board.currentVersion('0005')).toBe(versionBefore);
            expect(events.append).not.toHaveBeenCalled();
        });

        it('reclaims the worktree and records worktree.reclaimed when the move lands on a terminal stage', async () => {
            const { board, events, worktrees, service } = freshBoard();
            await board.create(card('0010', { stage: 'testing' }), 'seed');

            const detail = await service.move('0010', { stage: 'merged' });

            expect(detail.stage).toBe('merged');
            expect(worktrees.reclaim).toHaveBeenCalledTimes(1);
            expect(worktrees.reclaim).toHaveBeenCalledWith('0010');
            expect(events.append).toHaveBeenCalledWith(
                expect.objectContaining({ cardId: '0010', type: 'worktree.reclaimed', payload: { cardId: '0010', target: 'merged' } }),
            );
        });

        it("never reclaims a flagged card's tree, even on a terminal move that itself clears the flag (card 0055)", async () => {
            const { board, events, worktrees, service } = freshBoard();
            await board.create(card('0011', { stage: 'testing', needsHuman: true, needsHumanReason: 'stuck' }), 'seed');

            const detail = await service.move('0011', { stage: 'merged' });

            expect(detail.stage).toBe('merged');
            expect(detail.needsHuman).toBe(false);
            expect(worktrees.reclaim).not.toHaveBeenCalled();
            expect(events.append).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'worktree.reclaimed' }));
        });

        it('reclaims nothing when the move lands on an ordinary, non-terminal stage', async () => {
            const { board, worktrees, service } = freshBoard();
            await board.create(card('0012', { stage: 'implementing' }), 'seed');

            await service.move('0012', { stage: 'testing' });

            expect(worktrees.reclaim).not.toHaveBeenCalled();
        });

        it('still commits the transition and only logs a warning when the reclaim itself throws', async () => {
            const throwingWorktrees = {
                reclaim: vi.fn(async () => {
                    throw new Error('boom: directory busy');
                }),
            };
            const { board, events, service, logger } = freshBoard(throwingWorktrees);
            await board.create(card('0013', { stage: 'testing' }), 'seed');

            const detail = await service.move('0013', { stage: 'merged' });

            expect(detail.stage).toBe('merged');
            expect(events.append).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'worktree.reclaimed' }));
            expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('0013'));
            expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('boom: directory busy'));
        });
    });

    describe('edit', () => {
        it("edits a card's body and records the same version message the CLI records: \"Edit {id} plan body\"", async () => {
            const { board, service } = freshBoard();
            await board.create(card('0020', { stage: 'implementing' }), 'seed');

            const detail = await service.edit('0020', { body: 'new plan text' });

            expect(detail.body).toBe('new plan text');
            const stored = await board.read('0020');
            expect(stored.body).toBe('new plan text');
            const versions = await board.versions('0020', 10);
            expect(versions[0].message).toBe('Edit 0020 plan body');
        });

        it('writes nothing when the body is unchanged, unlike an ordinary edit', async () => {
            const { board, service } = freshBoard();
            await board.create(card('0021', { stage: 'implementing' }), 'seed');
            const versionBefore = await board.currentVersion('0021');

            const detail = await service.edit('0021', { body: 'body text' });

            expect(detail.body).toBe('body text');
            expect(await board.currentVersion('0021')).toBe(versionBefore);
        });

        it('answers a card that does not exist with a 404, matching getById', async () => {
            const { service } = freshBoard();

            await expect(service.edit('missing', { body: 'x' })).rejects.toMatchObject({ statusCode: 404 });
        });
    });
});
