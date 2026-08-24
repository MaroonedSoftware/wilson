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
 * A worktree layer that fails loudly the moment anything touches it, same as
 * `stage.dispatcher.budget.test.ts` uses: a card refused for its dependencies must never reach the
 * worktree layer at all, so any call is itself the failure, not just a wrong outcome.
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

const cardWithDeps = (id: string, stage: string, dependsOn: string[] = []): Card => ({
    frontmatter: {
        id,
        title: `card ${id}`,
        stage,
        dependsOn,
        retries: {},
    },
    sections: {},
    body: '## Goal\n\nDo the thing.\n\n## Files in scope\n\n- src/x.ts\n',
});

// A single testing-stage config with no budget cap: the run must reach the worktree layer once
// dependencies are satisfied, so `stagesYaml` deliberately carries nothing that could refuse it for
// any other reason.
const stagesYaml = `
stages:
  - name: testing
    mode: agent
    model: claude-opus
    instructions: test it
    onPass: merged
    onFail: needs-human
`;

/**
 * A git-backed board carrying every card in `cards`, wired to a `StageDispatcher` whose worktree
 * layer throws on first touch — the same shape `stage.dispatcher.budget.test.ts` uses to prove a
 * refusal never reaches the worktree, and to prove a non-refusal does.
 */
const setUp = async (cards: Card[]) => {
    const base = await mkdtemp(join(tmpdir(), 'stage-dispatcher-deps-'));
    const boardRoot = join(base, 'board');
    await mkdir(join(boardRoot, 'cards'), { recursive: true });
    await mkdir(join(boardRoot, 'config'), { recursive: true });
    await writeFile(join(boardRoot, 'config', 'stages.yaml'), stagesYaml, 'utf8');
    await exec('git', ['init', '-q', '-b', 'main'], { cwd: boardRoot });
    await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: boardRoot });
    await exec('git', ['config', 'user.name', 'Test'], { cwd: boardRoot });

    const config = new StaticBoardConfig('test', boardRoot, join(base, 'code'), join(base, 'worktrees'), join(base, 'run'));
    const board = new BoardRepository(config, silentLogger as never);
    for (const card of cards) {
        await board.create(card, 'initial');
    }

    const events = { append: vi.fn(async () => {}), totalInputTokens: vi.fn(async () => 0) };
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

    return { dispatcher, board, worktrees };
};

/**
 * Card 0023: `assertDispatchable` used to refuse any card naming a dependency at all, regardless of
 * whether that dependency had merged — the bug that dead-lettered card 0022 three times even though
 * its one dependency had already merged. It now asks `unsatisfiedDependencies`, the same question
 * `nextCard` answers, so a satisfied dependency must no longer block dispatch and an outstanding one
 * must be named specifically, not just announced as "dependencies exist".
 */
describe('StageDispatcher.run resolves dependencies through unsatisfiedDependencies', () => {
    it('refuses to dispatch a card with an unsatisfied dependency, before touching the worktree', async () => {
        const { dispatcher, worktrees } = await setUp([cardWithDeps('0001', 'testing', ['0002']), cardWithDeps('0002', 'implementing')]);

        await expect(dispatcher.run('0001', 'testing')).rejects.toThrow(/0001.*waiting on 0002/);

        expect(worktrees.branchName).not.toHaveBeenCalled();
        expect(worktrees.hasWork).not.toHaveBeenCalled();
        expect(worktrees.create).not.toHaveBeenCalled();
        expect(worktrees.resume).not.toHaveBeenCalled();
    });

    it('dispatches a card whose only dependency has merged, where the old length > 0 check would have refused it', async () => {
        const { dispatcher, worktrees } = await setUp([cardWithDeps('0001', 'testing', ['0002']), cardWithDeps('0002', 'merged')]);

        // A refusal would reject before ever calling branchName; reaching the worktree marker proves
        // dispatch proceeded past the dependency gate instead.
        await expect(dispatcher.run('0001', 'testing')).rejects.toThrow('MARKER: worktree touched');
        expect(worktrees.branchName).toHaveBeenCalledTimes(1);
    });

    it('dispatches a card with no dependencies at all, unaffected by the gate', async () => {
        const { dispatcher, worktrees } = await setUp([cardWithDeps('0001', 'testing')]);

        await expect(dispatcher.run('0001', 'testing')).rejects.toThrow('MARKER: worktree touched');
        expect(worktrees.branchName).toHaveBeenCalledTimes(1);
    });

    it('names only the outstanding dependency, not the merged one, when a card has a mix', async () => {
        const { dispatcher } = await setUp([
            cardWithDeps('0001', 'testing', ['0002', '0003']),
            cardWithDeps('0002', 'merged'),
            cardWithDeps('0003', 'planning'),
        ]);

        const failure = await dispatcher.run('0001', 'testing').catch((err: Error) => err);

        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toContain('0003');
        expect((failure as Error).message).not.toContain('0002');
    });

    it('refuses a card whose dependency is missing from the board entirely, the same as an unmerged one', async () => {
        const { dispatcher, worktrees } = await setUp([cardWithDeps('0001', 'testing', ['9999'])]);

        await expect(dispatcher.run('0001', 'testing')).rejects.toThrow(/0001.*waiting on 9999/);
        expect(worktrees.branchName).not.toHaveBeenCalled();
    });
});
