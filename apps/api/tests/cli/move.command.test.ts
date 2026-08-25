import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgresBoardRepository } from '#modules/board/postgres.board.repository.js';
import { BoardRepository } from '#modules/board/board.repository.js';
import { BoardConfig, StaticBoardConfig } from '#modules/board/board.config.js';
import { EventLog } from '#modules/events/event.log.js';
import { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';
import type { Card } from '#modules/board/card.js';
import type { Kysely } from 'kysely';
import type { DB } from '#modules/data/db.js';

// `move.command.ts` wraps its handler in johnny5's `requireContainer`, exactly like
// `approve.command.ts` — see that file's test for why the stub below is enough to make the wrapped
// handler directly callable.
vi.mock('@maroonedsoftware/johnny5/serverkit', () => ({
    requireContainer: (handler: unknown) => handler,
}));

const { default: command } = await import('../../../../packages/cli/src/commands/card/move.command.js');

type Handler = (opts: unknown, ctx: unknown, args: unknown[]) => Promise<number | void>;

const run = (ctx: unknown, cardId: string, target: string) => (command.run as unknown as Handler)({}, ctx, [cardId, target]);

const buildCtx = (
    board: BoardRepository,
    config: BoardConfig,
    worktrees: { reclaim: ReturnType<typeof vi.fn> } = { reclaim: vi.fn(async () => {}) },
    events: { append: ReturnType<typeof vi.fn> } = { append: vi.fn(async () => {}) },
) => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const container = {
        get: (token: unknown) => {
            if (token === BoardConfig) return config;
            if (token === BoardRepository) return board;
            if (token === WorktreeManager) return worktrees;
            if (token === EventLog) return events;
            throw new Error(`buildCtx: unexpected token ${String(token)}`);
        },
    };
    return { ctx: { container, logger }, logger, worktrees, events };
};

const card = (id: string, overrides: Partial<Card['frontmatter']> = {}): Card => ({
    frontmatter: { id, title: `card ${id}`, stage: 'implementing', dependsOn: [], retries: {}, ...overrides },
    sections: {},
    body: 'body text',
});

let db: Kysely<DB>;
let boardRoot: string;

beforeAll(async () => {
    db = testDb();

    const base = await mkdtemp(join(tmpdir(), 'move-command-'));
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

/** A fresh project + board repository for one test, isolated from every other by a unique project name. */
const freshBoard = () => {
    const events = { append: vi.fn(async () => {}) };
    const config = new StaticBoardConfig(uniqueProject(), boardRoot, '/tmp/code', '/tmp/wt', '/tmp/run');
    const board = new PostgresBoardRepository(config, db, events as unknown as EventLog);
    return { board, config, events };
};

describe('wilson card move', () => {
    it('clears a flagged card’s needsHuman fields on an ordinary move to a different stage', async () => {
        const { board, config } = freshBoard();
        await board.create(card('0001', { stage: 'implementing', needsHuman: true, needsHumanReason: 'stuck' }), 'seed');

        const { ctx } = buildCtx(board, config);
        const result = await run(ctx, '0001', 'testing');

        expect(result).toBe(0);
        const stored = await board.read('0001');
        expect(stored.frontmatter.stage).toBe('testing');
        // The board repository stores needsHuman as a NOT NULL boolean column, so an absent key on
        // write round-trips as `false`, not `undefined` — see postgres.board.repository.test.ts.
        expect(stored.frontmatter.needsHuman).toBe(false);
        expect(stored.frontmatter.needsHumanReason).toBeUndefined();
    });

    it('clears the flag even when the target is the stage the card is already in, instead of taking the no-op path', async () => {
        const { board, config, events } = freshBoard();
        await board.create(card('0002', { stage: 'implementing', needsHuman: true, needsHumanReason: 'stuck' }), 'seed');
        const versionBefore = await board.currentVersion('0002');

        const { ctx, logger } = buildCtx(board, config);
        const result = await run(ctx, '0002', 'implementing');

        expect(result).toBe(0);
        const stored = await board.read('0002');
        expect(stored.frontmatter.stage).toBe('implementing');
        expect(stored.frontmatter.needsHuman).toBe(false);
        expect(stored.frontmatter.needsHumanReason).toBeUndefined();

        // Actually wrote a new version — this did not take the bare "already in stage" no-op path.
        expect(await board.currentVersion('0002')).not.toBe(versionBefore);
        expect(events.append).toHaveBeenCalledTimes(1);
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('cleared flag'));
    });

    it('stays a true no-op — no write, no event, no log — when the card is already in the target stage and carries no flag', async () => {
        const { board, config, events } = freshBoard();
        await board.create(card('0003', { stage: 'implementing' }), 'seed');
        const versionBefore = await board.currentVersion('0003');

        const { ctx, logger } = buildCtx(board, config);
        const result = await run(ctx, '0003', 'implementing');

        expect(result).toBe(0);
        expect(await board.currentVersion('0003')).toBe(versionBefore);
        expect(events.append).not.toHaveBeenCalled();
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('already in'));
    });

    it('leaves an unflagged card’s absence of needsHuman fields alone on an ordinary move', async () => {
        const { board, config } = freshBoard();
        await board.create(card('0004', { stage: 'implementing' }), 'seed');

        const { ctx } = buildCtx(board, config);
        const result = await run(ctx, '0004', 'testing');

        expect(result).toBe(0);
        const stored = await board.read('0004');
        expect(stored.frontmatter.stage).toBe('testing');
        expect(stored.frontmatter.needsHuman).toBe(false);
    });
});

/**
 * Card 0064: `wilson card move` is the operator's override, and it writes a real transition — so it
 * must reclaim on the same rule the runner uses (`isTerminal(target)`) instead of leaving every
 * human-merged card's worktree behind. Before this card, moving a card to `merged` never touched
 * `WorktreeManager` at all; these tests would fail against that code, since `worktrees.reclaim` would
 * never be called.
 */
describe('wilson card move reclaims the worktree on a human terminal move', () => {
    it('reclaims the card’s worktree and records worktree.reclaimed when moved to merged', async () => {
        const { board, config, events } = freshBoard();
        await board.create(card('0010', { stage: 'testing' }), 'seed');
        const worktrees = { reclaim: vi.fn(async () => {}) };

        const { ctx } = buildCtx(board, config, worktrees, events);
        const result = await run(ctx, '0010', 'merged');

        expect(result).toBe(0);
        const stored = await board.read('0010');
        expect(stored.frontmatter.stage).toBe('merged');
        expect(worktrees.reclaim).toHaveBeenCalledTimes(1);
        expect(worktrees.reclaim).toHaveBeenCalledWith('0010');
        expect(events.append).toHaveBeenCalledWith(
            expect.objectContaining({
                cardId: '0010',
                type: 'worktree.reclaimed',
                payload: { cardId: '0010', target: 'merged' },
            }),
        );
    });

    it('reclaims on dropped and poisoned too, not only merged', async () => {
        const { board, config, events } = freshBoard();
        await board.create(card('0011', { stage: 'testing' }), 'seed');
        const worktrees = { reclaim: vi.fn(async () => {}) };

        const { ctx } = buildCtx(board, config, worktrees, events);
        const result = await run(ctx, '0011', 'dropped');

        expect(result).toBe(0);
        expect(worktrees.reclaim).toHaveBeenCalledWith('0011');
        expect(events.append).toHaveBeenCalledWith(expect.objectContaining({ type: 'worktree.reclaimed' }));
    });

    it('never reclaims a flagged card’s tree, even on a terminal move that itself clears the flag (card 0055)', async () => {
        const { board, config, events } = freshBoard();
        await board.create(card('0012', { stage: 'testing', needsHuman: true, needsHumanReason: 'stuck' }), 'seed');
        const worktrees = { reclaim: vi.fn(async () => {}) };

        const { ctx } = buildCtx(board, config, worktrees, events);
        const result = await run(ctx, '0012', 'merged');

        expect(result).toBe(0);
        const stored = await board.read('0012');
        expect(stored.frontmatter.stage).toBe('merged');
        expect(stored.frontmatter.needsHuman).toBe(false);
        expect(worktrees.reclaim).not.toHaveBeenCalled();
        expect(events.append).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'worktree.reclaimed' }));
    });

    it('reclaims nothing when the move lands on an ordinary, non-terminal stage', async () => {
        const { board, config, events } = freshBoard();
        await board.create(card('0013', { stage: 'implementing' }), 'seed');
        const worktrees = { reclaim: vi.fn(async () => {}) };

        const { ctx } = buildCtx(board, config, worktrees, events);
        const result = await run(ctx, '0013', 'testing');

        expect(result).toBe(0);
        expect(worktrees.reclaim).not.toHaveBeenCalled();
        expect(events.append).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'worktree.reclaimed' }));
    });

    it('still writes the transition and only logs a warning when the reclaim itself throws', async () => {
        const { board, config, events } = freshBoard();
        await board.create(card('0014', { stage: 'testing' }), 'seed');
        const worktrees = { reclaim: vi.fn(async () => { throw new Error('boom: directory busy'); }) };

        const { ctx, logger } = buildCtx(board, config, worktrees, events);
        const result = await run(ctx, '0014', 'merged');

        expect(result).toBe(0);
        const stored = await board.read('0014');
        expect(stored.frontmatter.stage).toBe('merged');
        expect(events.append).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'worktree.reclaimed' }));
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('0014'));
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('boom: directory busy'));
    });
});
