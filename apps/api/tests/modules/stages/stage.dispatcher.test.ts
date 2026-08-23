import { execFile } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StageDispatcher } from '#modules/stages/stage.dispatcher.js';
import { BoardRepository } from '#modules/board/board.repository.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import type { Card } from '#modules/board/card.js';
import type { StageConfig } from '#modules/stages/stage.config.js';
import type { StageOutcome } from '#modules/stages/stage.result.js';
import type { EventLog } from '#modules/events/event.log.js';
import type { BoardConfig } from '#modules/board/board.config.js';
import type { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import type { ModelRegistry } from '#modules/agent/model.registry.js';
import type { StageVerifierMap } from '#modules/stages/stage.verifier.js';
import type { StageResultSchemaMap } from '#modules/stages/stage.result.js';

const exec = promisify(execFile);
const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const baseCard: Card = {
    frontmatter: {
        id: '0001',
        title: 'do the thing',
        stage: 'testing',
        dependsOn: [],
        retries: {},
    },
    sections: {},
    body: '## Goal\n\nDo the thing.',
};

const makeStage = (overrides: Partial<StageConfig> = {}): StageConfig => ({
    name: 'testing',
    mode: 'agent',
    worktree: 'rw',
    provider: 'anthropic',
    model: 'claude-opus',
    instructions: 'test the thing',
    allowedCommands: [],
    worktreeFrom: 'branch',
    extraScope: [],
    baselineCheck: true,
    maxSteps: 60,
    maxOutputTokens: 16000,
    onPass: 'review',
    onFail: 'implementing',
    maxKickbacks: 3,
    ...overrides,
});

const outcome = (overrides: Partial<StageOutcome> = {}): StageOutcome => ({
    passed: true,
    failures: [],
    changedPaths: [],
    scopeGrants: [],
    usage: {},
    ...overrides,
});

/**
 * Exercises the transition-writing half of the dispatcher against a real board repo: an in-memory
 * mock of `BoardRepository.write` would only prove the test agrees with itself about what "write"
 * means, not that the card on disk actually moves.
 */
describe('StageDispatcher writeTransition (via private access — run() drags in the whole agent loop)', () => {
    let board: BoardRepository;
    let boardRoot: string;
    let events: { append: ReturnType<typeof vi.fn> };
    let dispatcher: StageDispatcher;

    beforeEach(async () => {
        const base = await mkdtemp(join(tmpdir(), 'stage-dispatcher-'));
        boardRoot = join(base, 'board');
        await mkdir(join(boardRoot, 'cards'), { recursive: true });
        await exec('git', ['init', '-q', '-b', 'main'], { cwd: boardRoot });
        await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: boardRoot });
        await exec('git', ['config', 'user.name', 'Test'], { cwd: boardRoot });

        const config = new StaticBoardConfig('test', boardRoot, join(base, 'code'), join(base, 'worktrees'), join(base, 'run'));
        board = new BoardRepository(config, silentLogger as never);
        await board.create(baseCard, 'initial');

        events = { append: vi.fn(async () => {}) };

        dispatcher = new StageDispatcher(
            config as BoardConfig,
            board,
            {} as WorktreeManager,
            {} as ModelRegistry,
            {} as StageVerifierMap,
            {} as StageResultSchemaMap,
            events as unknown as EventLog,
            silentLogger as never,
        );
    });

    const writeTransition = (stage: StageConfig, card: Card, result: StageOutcome) =>
        (
            dispatcher as unknown as {
                writeTransition(cardId: string, stageName: string, stage: StageConfig, card: Card, outcome: StageOutcome): Promise<string>;
            }
        ).writeTransition('0001', 'testing', stage, card, result);

    it('advances a passing stage to onPass and leaves the body untouched', async () => {
        const stage = makeStage({ onPass: 'review' });

        const target = await writeTransition(stage, baseCard, outcome({ passed: true }));

        expect(target).toBe('review');
        const stored = await board.read('0001');
        expect(stored.frontmatter.stage).toBe('review');
        expect(stored.frontmatter.retries).toEqual({});
        expect(stored.body).toBe(baseCard.body);
    });

    it('kicks a failing stage back to onFail and bumps its retry counter', async () => {
        const stage = makeStage({ onFail: 'implementing', maxKickbacks: 3 });

        const target = await writeTransition(stage, baseCard, outcome({ passed: false }));

        expect(target).toBe('implementing');
        const stored = await board.read('0001');
        expect(stored.frontmatter.stage).toBe('implementing');
        expect(stored.frontmatter.retries).toEqual({ testing: 1 });
    });

    it('sends a review that asks for revision backward even though the stage itself passed', async () => {
        const stage = makeStage({ name: 'review', onPass: 'merge', onFail: 'implementing', maxKickbacks: 3 });
        const card: Card = { ...baseCard, frontmatter: { ...baseCard.frontmatter, stage: 'review' } };

        const target = await writeTransition(
            stage,
            card,
            outcome({
                passed: true,
                result: {
                    verdict: 'revise',
                    findings: [{ severity: 'blocker', file: 'src/x.ts', line: 3, problem: 'wrong', suggestion: 'fix it' }],
                },
            }),
        );

        expect(target).toBe('implementing');
        const stored = await board.read('0001');
        expect(stored.frontmatter.stage).toBe('implementing');
        expect(stored.frontmatter.retries).toEqual({ review: 1 });
        expect(stored.body).toContain('## Review findings');
        expect(stored.body).toContain('src/x.ts:3');
    });

    it('advances a clean review and does not fabricate a findings section', async () => {
        const stage = makeStage({ name: 'review', onPass: 'merge', onFail: 'implementing' });
        const card: Card = { ...baseCard, frontmatter: { ...baseCard.frontmatter, stage: 'review' } };

        const target = await writeTransition(stage, card, outcome({ passed: true, result: { verdict: 'pass', findings: [] } }));

        expect(target).toBe('merge');
        const stored = await board.read('0001');
        expect(stored.body).toBe(baseCard.body);
        expect(stored.body).not.toContain('Review findings');
    });

    it('records a transition.written event describing where the card came from and where it went', async () => {
        const stage = makeStage({ onPass: 'review' });

        await writeTransition(stage, baseCard, outcome({ passed: true }));

        expect(events.append).toHaveBeenCalledWith(
            expect.objectContaining({
                cardId: '0001',
                stage: 'testing',
                type: 'transition.written',
                payload: { from: 'testing', to: 'review', retries: {}, by: 'runner' },
            }),
        );
    });

    it('commits the transition to the board repo, not just the working tree', async () => {
        const stage = makeStage({ onPass: 'review' });

        await writeTransition(stage, baseCard, outcome({ passed: true }));

        const { stdout } = await exec('git', ['log', '-1', '--pretty=%s'], { cwd: boardRoot });
        expect(stdout.trim()).toBe('0001: testing -> review');
    });

    it('routes to needs-human once a kicked-back card exhausts its retries', async () => {
        const stage = makeStage({ onFail: 'implementing', maxKickbacks: 1 });

        const target = await writeTransition(stage, baseCard, outcome({ passed: false }));

        expect(target).toBe('needs-human');
        const stored = await board.read('0001');
        expect(stored.frontmatter.stage).toBe('needs-human');
    });
});
