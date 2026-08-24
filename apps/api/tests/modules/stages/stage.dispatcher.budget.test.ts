import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { StageDispatcher } from '#modules/stages/stage.dispatcher.js';
import { BoardRepository } from '#modules/board/board.repository.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { StageAgentMap } from '#modules/agent/stage.agent.js';
import { StageVerifierMap } from '#modules/stages/stage.verifier.js';
import { StageResultSchemaMap } from '#modules/stages/stage.result.js';
import type { Card } from '#modules/board/card.js';
import type { EventLog } from '#modules/events/event.log.js';
import type { WorktreeManager } from '#modules/worktree/worktree.manager.js';

const exec = promisify(execFile);
const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/**
 * A worktree layer that fails loudly the moment anything touches it. The over-budget path must
 * never reach any of these calls, so any call at all is a test failure, not just a wrong outcome —
 * a mock that silently no-ops would let a bug that dispatches anyway pass unnoticed.
 */
const untouchableWorktrees = () => ({
    branchName: vi.fn(() => {
        throw new Error('MARKER: worktree touched');
    }),
    hasWork: vi.fn(async () => {
        throw new Error('MARKER: worktree touched');
    }),
    resume: vi.fn(async () => {
        throw new Error('MARKER: worktree touched');
    }),
    create: vi.fn(async () => {
        throw new Error('MARKER: worktree touched');
    }),
    rebaseOntoHead: vi.fn(async () => {
        throw new Error('MARKER: worktree touched');
    }),
    commit: vi.fn(async () => {
        throw new Error('MARKER: worktree touched');
    }),
    reclaim: vi.fn(async () => {}),
});

const baseCard: Card = {
    frontmatter: {
        id: '0001',
        title: 'do the thing',
        stage: 'testing',
        dependsOn: [],
        retries: {},
    },
    sections: {},
    body: '## Goal\n\nDo the thing.\n\n## Files in scope\n\n- src/x.ts\n',
};

// onPass/onFail point at terminal states rather than other configured stages, so a single-stage
// file satisfies `assertRoutesResolve` (every route must resolve to a known stage or terminal
// state) without pulling in stages this card's behaviour has nothing to do with.
const stagesYamlWithCap = `
stages:
  - name: testing
    mode: agent
    model: claude-opus
    instructions: test it
    onPass: merged
    onFail: needs-human
    maxCardInputTokens: 1000000
`;

const stagesYamlNoCap = `
stages:
  - name: testing
    mode: agent
    model: claude-opus
    instructions: test it
    onPass: merged
    onFail: needs-human
`;

/**
 * Sets up a real, git-backed board (as `stage.dispatcher.test.ts` already does for
 * `writeTransition`) with the given `stages.yaml`, and a `StageDispatcher` wired to an
 * `EventLog.totalInputTokens` stubbed to `spend` and a worktree layer that throws on first touch.
 */
const setUp = async (stagesYaml: string, spend: number) => {
    const base = await mkdtemp(join(tmpdir(), 'stage-dispatcher-budget-'));
    const boardRoot = join(base, 'board');
    await mkdir(join(boardRoot, 'cards'), { recursive: true });
    await mkdir(join(boardRoot, 'config'), { recursive: true });
    await writeFile(join(boardRoot, 'config', 'stages.yaml'), stagesYaml, 'utf8');
    await exec('git', ['init', '-q', '-b', 'main'], { cwd: boardRoot });
    await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: boardRoot });
    await exec('git', ['config', 'user.name', 'Test'], { cwd: boardRoot });

    const config = new StaticBoardConfig('test', boardRoot, join(base, 'code'), join(base, 'worktrees'), join(base, 'run'));
    const board = new BoardRepository(config, silentLogger as never);
    await board.create(baseCard, 'initial');

    const events = { append: vi.fn(async () => {}), totalInputTokens: vi.fn(async () => spend) };
    const worktrees = untouchableWorktrees();

    const dispatcher = new StageDispatcher(
        config,
        board,
        worktrees as unknown as WorktreeManager,
        new StageAgentMap(),
        new StageVerifierMap(),
        new StageResultSchemaMap(),
        events as unknown as EventLog,
        silentLogger as never,
    );

    return { dispatcher, board, boardRoot, events, worktrees };
};

/**
 * Card 0018: a card that has already spent its configured `maxCardInputTokens` must be refused at
 * dispatch, before any worktree is cut — not discovered once the run has already spent more.
 */
describe('StageDispatcher.run refuses an over-budget card before touching the worktree', () => {
    it('refuses to dispatch once spend has reached the cap, and touches no worktree method at all', async () => {
        const { dispatcher, events, worktrees } = await setUp(stagesYamlWithCap, 1_000_000);

        const result = await dispatcher.run('0001', 'testing');

        expect(result.passed).toBe(false);
        expect(result.transitionedTo).toBe('needs-human');
        expect(result.failures[0]).toMatch(/spent its budget/);
        expect(result.failures[0]).toMatch(/1000000/);

        expect(worktrees.branchName).not.toHaveBeenCalled();
        expect(worktrees.hasWork).not.toHaveBeenCalled();
        expect(worktrees.create).not.toHaveBeenCalled();
        expect(worktrees.resume).not.toHaveBeenCalled();

        expect(events.totalInputTokens).toHaveBeenCalledWith('test', '0001');
        expect(events.append).toHaveBeenCalledWith(
            expect.objectContaining({
                cardId: '0001',
                stage: 'testing',
                type: 'card.over-budget',
                payload: { spent: 1_000_000, cap: 1_000_000 },
            }),
        );
    });

    it('refuses once spend exceeds the cap, not only when it lands exactly on it', async () => {
        const { dispatcher, worktrees } = await setUp(stagesYamlWithCap, 5_000_000);

        const result = await dispatcher.run('0001', 'testing');

        expect(result.passed).toBe(false);
        expect(worktrees.branchName).not.toHaveBeenCalled();
    });

    it('writes the transition to needs-human through the board, exactly as an exhausted kickback would', async () => {
        const { dispatcher, board, boardRoot } = await setUp(stagesYamlWithCap, 5_000_000);

        await dispatcher.run('0001', 'testing');

        const stored = await board.read('0001');
        expect(stored.frontmatter.stage).toBe('needs-human');
        // Retries are for work that came back wrong; this card never ran the stage at all.
        expect(stored.frontmatter.retries).toEqual({});

        const { stdout } = await exec('git', ['log', '-1', '--pretty=%s'], { cwd: boardRoot });
        expect(stdout.trim()).toBe('0001: testing -> needs-human');
    });

    it('reclaims whatever worktree an earlier attempt left behind, since needs-human is terminal', async () => {
        const { dispatcher, worktrees, events } = await setUp(stagesYamlWithCap, 5_000_000);

        await dispatcher.run('0001', 'testing');

        expect(worktrees.reclaim).toHaveBeenCalledWith('0001');
        expect(events.append).toHaveBeenCalledWith(expect.objectContaining({ type: 'worktree.reclaimed' }));
    });

    it('does not consult spend at all, and proceeds toward the worktree, when no cap is configured', async () => {
        const { dispatcher, events } = await setUp(stagesYamlNoCap, 10_000_000);

        // Absent `maxCardInputTokens` must behave exactly as it does today: unbounded. The dispatcher
        // reaches the worktree layer, which throws its marker error — proving the budget gate did not
        // short-circuit the run, since a refusal would have returned normally instead of throwing.
        await expect(dispatcher.run('0001', 'testing')).rejects.toThrow('MARKER: worktree touched');
        expect(events.totalInputTokens).not.toHaveBeenCalled();
    });

    it('does not refuse the card, and proceeds toward the worktree, when spend sits below the cap', async () => {
        const { dispatcher, events } = await setUp(stagesYamlWithCap, 500);

        await expect(dispatcher.run('0001', 'testing')).rejects.toThrow('MARKER: worktree touched');
        expect(events.totalInputTokens).toHaveBeenCalledWith('test', '0001');
        expect(events.append).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'card.over-budget' }));
    });
});
