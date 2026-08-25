import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgresBoardRepository } from '#modules/board/postgres.board.repository.js';
import { BoardRepository } from '#modules/board/board.repository.js';
import { BoardConfig, StaticBoardConfig } from '#modules/board/board.config.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';
import type { Card } from '#modules/board/card.js';
import type { EventLog } from '#modules/events/event.log.js';
import type { Kysely } from 'kysely';
import type { DB } from '#modules/data/db.js';

// `ack.command.ts` wraps its handler in johnny5's `requireContainer`, exactly like
// `approve.command.ts` — see that file's test for why the stub below is enough to make the wrapped
// handler directly callable.
vi.mock('@maroonedsoftware/johnny5/serverkit', () => ({
    requireContainer: (handler: unknown) => handler,
}));

const { default: command } = await import('../../../../packages/cli/src/commands/card/ack.command.js');

type Handler = (opts: unknown, ctx: unknown, args: unknown[]) => Promise<number | void>;

const run = (ctx: unknown, cardId: string) => (command.run as unknown as Handler)({}, ctx, [cardId]);

const buildCtx = (board: BoardRepository, config: BoardConfig) => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const container = {
        get: (token: unknown) => {
            if (token === BoardConfig) return config;
            if (token === BoardRepository) return board;
            throw new Error(`buildCtx: unexpected token ${String(token)}`);
        },
    };
    return { ctx: { container, logger }, logger };
};

const card = (id: string, overrides: Partial<Card['frontmatter']> = {}): Card => ({
    frontmatter: { id, title: `card ${id}`, stage: 'implementing', dependsOn: [], retries: {}, ...overrides },
    sections: {},
    body: 'body text',
});

let db: Kysely<DB>;

beforeAll(() => {
    db = testDb();
});

afterAll(async () => {
    await db.destroy();
});

/** A fresh project + board repository for one test, isolated from every other by a unique project name. */
const freshBoard = () => {
    const events = { append: vi.fn(async () => {}) };
    const config = new StaticBoardConfig(uniqueProject(), '/tmp/board', '/tmp/code', '/tmp/wt', '/tmp/run');
    const board = new PostgresBoardRepository(config, db, events as unknown as EventLog);
    return { board, config, events };
};

describe('wilson card ack', () => {
    it('refuses an unflagged card, exits 1, and writes nothing', async () => {
        const { board, config, events } = freshBoard();
        await board.create(card('0001', { stage: 'implementing', retries: { implementing: 2 } }), 'seed');
        const versionBefore = await board.currentVersion('0001');

        const { ctx, logger } = buildCtx(board, config);
        const result = await run(ctx, '0001');

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('not flagged'));
        expect(events.append).not.toHaveBeenCalled();

        const stored = await board.read('0001');
        expect(stored.frontmatter.retries).toEqual({ implementing: 2 });
        expect(await board.currentVersion('0001')).toBe(versionBefore);
    });

    it('clears the flag, drops only the current stage retry counter, leaves stage unchanged, and appends one card.acked event', async () => {
        const { board, config, events } = freshBoard();
        await board.create(
            card('0002', {
                stage: 'implementing',
                retries: { implementing: 3, review: 1 },
                needsHuman: true,
                needsHumanReason: 'kicked back too many times',
            }),
            'seed',
        );

        const { ctx, logger } = buildCtx(board, config);
        const result = await run(ctx, '0002');

        expect(result).toBe(0);

        const stored = await board.read('0002');
        expect(stored.frontmatter.stage).toBe('implementing');
        // The board repository stores needsHuman as a NOT NULL boolean column, so an absent key on
        // write round-trips as `false`, not `undefined` — see postgres.board.repository.test.ts.
        expect(stored.frontmatter.needsHuman).toBe(false);
        expect(stored.frontmatter.needsHumanReason).toBeUndefined();
        // Only the flagged stage's counter is dropped; an earlier cycle's counter for another stage
        // survives untouched.
        expect(stored.frontmatter.retries).toEqual({ review: 1 });

        expect(events.append).toHaveBeenCalledTimes(1);
        expect(events.append).toHaveBeenCalledWith(
            expect.objectContaining({
                cardId: '0002',
                stage: 'implementing',
                type: 'card.acked',
                payload: { stage: 'implementing', reason: 'kicked back too many times', retries: 3, by: 'human' },
            }),
            expect.anything(),
        );

        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('implementing'));
    });

    it('deletes the retry key entirely rather than zeroing it, so a stage that never failed and one just acked look identical', async () => {
        const { board, config } = freshBoard();
        await board.create(card('0003', { stage: 'testing', retries: { testing: 1 }, needsHuman: true }), 'seed');

        const { ctx } = buildCtx(board, config);
        await run(ctx, '0003');

        const stored = await board.read('0003');
        expect('testing' in stored.frontmatter.retries).toBe(false);
    });

    it('handles a flagged card with no retry counter recorded for its stage, dropping nothing and still clearing the flag', async () => {
        const { board, config, events } = freshBoard();
        await board.create(card('0004', { stage: 'review', retries: {}, needsHuman: true, needsHumanReason: 'looks wrong' }), 'seed');

        const { ctx } = buildCtx(board, config);
        const result = await run(ctx, '0004');

        expect(result).toBe(0);
        const stored = await board.read('0004');
        expect(stored.frontmatter.needsHuman).toBe(false);
        expect(stored.frontmatter.retries).toEqual({});

        expect(events.append).toHaveBeenCalledWith(
            expect.objectContaining({ payload: expect.objectContaining({ retries: undefined }) }),
            expect.anything(),
        );
    });
});
