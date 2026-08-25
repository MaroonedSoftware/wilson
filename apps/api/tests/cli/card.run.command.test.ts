import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardConfig, BoardRepository, StageDispatcher, type Card } from '@wilson/api/cli-bootstrap';

// `run.command.ts` (card/run.command.ts, not the daemon's run.command.ts covered by
// `run.command.test.ts`) wraps its handler in johnny5's `requireContainer`, exactly like the other
// CLI commands under test here.
vi.mock('@maroonedsoftware/johnny5/serverkit', () => ({
    requireContainer: (handler: unknown) => handler,
}));

const { default: command } = await import('../../../../packages/cli/src/commands/card/run.command.js');

type Handler = (opts: unknown, ctx: unknown, args: unknown[]) => Promise<number | void>;
const run = (ctx: unknown, cardId: string, stage?: string) => (command.run as unknown as Handler)({ stage }, ctx, [cardId]);

const buildCard = (overrides: Partial<Card['frontmatter']> = {}): Card => ({
    frontmatter: { id: '0099', title: 'a card', stage: 'implementing', dependsOn: [], retries: {}, ...overrides },
    sections: {},
    body: '## Goal\n\nDo it.\n\n## Files in scope\n\n- src/a.ts\n',
});

const dispatchOutcome = {
    passed: true,
    result: undefined,
    changedPaths: [] as string[],
    scopeGrants: [] as string[],
    failures: [] as string[],
    usage: undefined,
};

describe('wilson card run', () => {
    let boardRoot: string;
    let logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> };
    let dispatcherRun: ReturnType<typeof vi.fn>;

    const buildCtx = (board: { read: ReturnType<typeof vi.fn> }) => ({
        container: {
            get: (token: unknown) => {
                if (token === BoardConfig) return { boardRoot } as unknown as BoardConfig;
                if (token === BoardRepository) return board;
                if (token === StageDispatcher) return { run: dispatcherRun };
                throw new Error(`buildCtx: unexpected token ${String(token)}`);
            },
        },
        logger,
    });

    beforeEach(async () => {
        const base = await mkdtemp(join(tmpdir(), 'card-run-cmd-'));
        boardRoot = join(base, 'board');
        await mkdir(join(boardRoot, 'config'), { recursive: true });
        await writeFile(
            join(boardRoot, 'config', 'stages.yaml'),
            [
                'stages:',
                '  - name: implementing',
                '    mode: agent',
                '    model: claude-test-model',
                '    instructions: do it',
                '    onPass: merged',
                '    onFail: implementing',
                '  - name: planning',
                '    mode: manual',
                '    model: claude-test-model',
                '    instructions: read the plan',
                '    onPass: implementing',
                '    onFail: planning',
                '',
            ].join('\n'),
            'utf8',
        );
        logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
        dispatcherRun = vi.fn().mockResolvedValue(dispatchOutcome);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('refuses a card flagged for a human, the same way `card start` refuses it, without dispatching', async () => {
        const card = buildCard({ needsHuman: true, needsHumanReason: 'stuck on an API decision' });
        const board = { read: vi.fn().mockResolvedValue(card) };

        const result = await run(buildCtx(board), '0099');

        expect(result).toBe(1);
        expect(dispatcherRun).not.toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('cannot run 0099'));
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('stuck on an API decision'));
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('wilson card move 0099'));
    });

    it('refuses a card sitting in a manual stage, exiting non-zero rather than reaching the dispatcher', async () => {
        const card = buildCard({ stage: 'planning' });
        const board = { read: vi.fn().mockResolvedValue(card) };

        const result = await run(buildCtx(board), '0099', 'planning');

        expect(result).toBe(1);
        expect(dispatcherRun).not.toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('manual'));
    });

    it('refuses a card in a terminal stage rather than throwing', async () => {
        const card = buildCard({ stage: 'merged' });
        const board = { read: vi.fn().mockResolvedValue(card) };

        const result = await run(buildCtx(board), '0099', 'merged');

        expect(result).toBe(1);
        expect(dispatcherRun).not.toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('terminal'));
    });

    it('behaves exactly as before for a dispatchable card: it reads the card and runs the stage', async () => {
        const card = buildCard({ stage: 'implementing' });
        const board = { read: vi.fn().mockResolvedValue(card) };

        const result = await run(buildCtx(board), '0099', 'implementing');

        expect(result).toBe(0);
        expect(dispatcherRun).toHaveBeenCalledWith('0099', 'implementing');
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('PASS'));
    });
});
