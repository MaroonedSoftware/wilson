import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgresBoardRepository } from '#modules/board/postgres.board.repository.js';
import { BoardRepository } from '#modules/board/board.repository.js';
import { BoardConfig, StaticBoardConfig } from '#modules/board/board.config.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';
import type { Card } from '#modules/board/card.js';
import type { EventLog } from '#modules/events/event.log.js';
import type { Kysely } from 'kysely';
import type { DB } from '#modules/data/db.js';

// `approve.command.ts` wraps its handler in johnny5's `requireContainer`, exactly like
// `run.command.ts` — see that file's test for why the stub below is enough to make the wrapped
// handler directly callable.
vi.mock('@maroonedsoftware/johnny5/serverkit', () => ({
    requireContainer: (handler: unknown) => handler,
}));

const { default: command } = await import('../../../../packages/cli/src/commands/card/approve.command.js');

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

const cardWithScope = (id: string, stage: string, body = '## Goal\n\nDo it.\n\n## Files in scope\n\n- src/a.ts\n'): Card => ({
    frontmatter: { id, title: `card ${id}`, stage, dependsOn: [], retries: {} },
    sections: {},
    body,
});

let db: Kysely<DB>;
let boardRoot: string;

beforeAll(async () => {
    db = testDb();

    // `approve.command.ts` reads `backlog`'s own `onPass` from `stages.yaml` rather than
    // hard-coding `implementing` — the fixture below routes `backlog` to `testing`, a name no
    // hard-coded fallback would ever produce, so a regression back to a literal `implementing`
    // shows up as a wrong assertion rather than an accidental pass.
    const base = await mkdtemp(join(tmpdir(), 'approve-command-'));
    boardRoot = join(base, 'board');
    await mkdir(join(boardRoot, 'config'), { recursive: true });
    await writeFile(
        join(boardRoot, 'config', 'stages.yaml'),
        [
            'stages:',
            '  - name: backlog',
            '    mode: manual',
            '    model: claude-opus',
            '    instructions: read the plan',
            '    onPass: testing',
            '    onFail: backlog',
            '  - name: testing',
            '    mode: agent',
            '    model: claude-opus',
            '    instructions: test the thing',
            '    onPass: merged',
            '    onFail: backlog',
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

describe('wilson card approve', () => {
    it('refuses a card outside backlog, and writes nothing', async () => {
        const { board, config } = freshBoard();
        await board.create(cardWithScope('0001', 'implementing'), 'seed');

        const { ctx, logger } = buildCtx(board, config);
        const result = await run(ctx, '0001');

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('implementing'));

        const stored = await board.read('0001');
        expect(stored.frontmatter.stage).toBe('implementing');
        expect(stored.frontmatter.planVersionId).toBeUndefined();
    });

    it('refuses a backlog card whose plan has an empty "Files in scope", and writes nothing', async () => {
        const { board, config } = freshBoard();
        await board.create(cardWithScope('0002', 'backlog', '## Goal\n\nDo it.\n\n## Files in scope\n\n'), 'seed');

        const { ctx, logger } = buildCtx(board, config);
        const result = await run(ctx, '0002');

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Files in scope'));

        const stored = await board.read('0002');
        expect(stored.frontmatter.stage).toBe('backlog');
        expect(stored.frontmatter.planVersionId).toBeUndefined();
    });

    it('pins the approved version, moves the card to backlog’s configured onPass, and records one transition.written event carrying it', async () => {
        const { board, config, events } = freshBoard();
        const approvedVersion = await board.create(cardWithScope('0003', 'backlog'), 'seed');

        const { ctx, logger } = buildCtx(board, config);
        const result = await run(ctx, '0003');

        expect(result).toBe(0);

        const stored = await board.read('0003');
        // Not the hard-coded `implementing` — the target this fixture's stages.yaml actually names.
        expect(stored.frontmatter.stage).toBe('testing');
        // The version holding the plan text a human just read and approved, not whatever version
        // this very approval is about to create.
        expect(stored.frontmatter.planVersionId).toBe(approvedVersion);

        const versionAfterApproval = await board.currentVersion('0003');
        expect(versionAfterApproval).not.toBe(approvedVersion);

        expect(events.append).toHaveBeenCalledTimes(1);
        expect(events.append).toHaveBeenCalledWith(
            expect.objectContaining({
                cardId: '0003',
                stage: 'testing',
                type: 'transition.written',
                payload: { from: 'backlog', to: 'testing', by: 'human', planVersionId: approvedVersion },
            }),
            expect.anything(),
        );

        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('backlog → testing'));
    });

    it('pins the plan text as it stood at approval, so an edit made afterwards does not change what a stage reads', async () => {
        const { board, config } = freshBoard();
        const approvedBody = '## Goal\n\nApprove me.\n\n## Files in scope\n\n- src/a.ts\n';
        await board.create(cardWithScope('0004', 'backlog', approvedBody), 'seed');

        const { ctx } = buildCtx(board, config);
        await run(ctx, '0004');

        const pinnedVersion = (await board.read('0004')).frontmatter.planVersionId;
        expect(pinnedVersion).toBeDefined();

        // A human edits the card after approval — this is exactly the edit `StageDispatcher.run`'s
        // pin exists to protect against retroactively changing the contract of a running stage.
        await board.write('0004', 'edit after approval', card => ({
            ...card,
            body: '## Goal\n\nA different plan entirely.\n\n## Files in scope\n\n- src/b.ts\n',
        }));

        const current = await board.read('0004');
        expect(current.body).toContain('A different plan entirely');

        // What `StageDispatcher.run` actually reads: `board.readAt(id, planVersionId)`, not `board.read(id)`.
        const pinned = await board.readAt('0004', pinnedVersion!);
        expect(pinned.body).toBe(approvedBody);
        expect(pinned.body).not.toContain('A different plan entirely');
    });
});
