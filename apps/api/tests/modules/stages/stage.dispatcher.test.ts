import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { StageDispatcher } from '#modules/stages/stage.dispatcher.js';
import { BoardRepository } from '#modules/board/board.repository.js';
import { PostgresBoardRepository } from '#modules/board/postgres.board.repository.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { ScopeGuard } from '#modules/agent/scope.guard.js';
import { StageAgentMap, type AgentRunOutput } from '#modules/agent/stage.agent.js';
import { StageVerifierMap, type StageVerifier, type VerificationOutcome } from '#modules/stages/stage.verifier.js';
import { StageResultSchemaMap } from '#modules/stages/stage.result.js';
import type { Card } from '#modules/board/card.js';
import type { StageConfig } from '#modules/stages/stage.config.js';
import type { StageOutcome } from '#modules/stages/stage.result.js';
import type { EventLog } from '#modules/events/event.log.js';
import type { BoardConfig } from '#modules/board/board.config.js';
import type { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import type { ModelRegistry } from '#modules/agent/model.registry.js';
import type { Kysely } from 'kysely';
import type { DB } from '#modules/data/db.js';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

// The board is Postgres now, so these exercise a real database rather than a real git repo. One
// connection per file; isolation comes from a unique project per test, since cards are keyed by
// (project, id).
let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
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

        events = { append: vi.fn(async () => {}) };
        const config = new StaticBoardConfig(uniqueProject(), boardRoot, join(base, 'code'), join(base, 'worktrees'), join(base, 'run'));
        board = new PostgresBoardRepository(config, db, events as unknown as EventLog);
        await board.create(baseCard, 'initial');

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
                writeTransition(
                    cardId: string,
                    stageName: string,
                    stage: StageConfig,
                    card: Card,
                    outcome: StageOutcome,
                ): Promise<{ target: string; needsHuman: boolean }>;
            }
        ).writeTransition('0001', 'testing', stage, card, result);

    it('advances a passing stage to onPass and leaves the body untouched', async () => {
        const stage = makeStage({ onPass: 'review' });

        const { target } = await writeTransition(stage, baseCard, outcome({ passed: true }));

        expect(target).toBe('review');
        const stored = await board.read('0001');
        expect(stored.frontmatter.stage).toBe('review');
        expect(stored.frontmatter.retries).toEqual({});
        expect(stored.body).toBe(baseCard.body);
    });

    it('kicks a failing stage back to onFail and bumps its retry counter', async () => {
        const stage = makeStage({ onFail: 'implementing', maxKickbacks: 3 });

        const { target } = await writeTransition(stage, baseCard, outcome({ passed: false }));

        expect(target).toBe('implementing');
        const stored = await board.read('0001');
        expect(stored.frontmatter.stage).toBe('implementing');
        expect(stored.frontmatter.retries).toEqual({ testing: 1 });
    });

    it('sends a review that asks for revision backward even though the stage itself passed', async () => {
        const stage = makeStage({ name: 'review', onPass: 'merge', onFail: 'implementing', maxKickbacks: 3 });
        const card: Card = { ...baseCard, frontmatter: { ...baseCard.frontmatter, stage: 'review' } };

        const { target } = await writeTransition(
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

        const { target } = await writeTransition(stage, card, outcome({ passed: true, result: { verdict: 'pass', findings: [] } }));

        expect(target).toBe('merge');
        const stored = await board.read('0001');
        expect(stored.body).toBe(baseCard.body);
        expect(stored.body).not.toContain('Review findings');
    });

    it('records a transition.written event describing where the card came from and where it went', async () => {
        const stage = makeStage({ onPass: 'review' });

        await writeTransition(stage, baseCard, outcome({ passed: true }));

        // The second argument is the open transaction the card was moved in. Its presence is the
        // point: the event and the move commit together, so neither can survive without the other.
        expect(events.append).toHaveBeenCalledWith(
            expect.objectContaining({
                cardId: '0001',
                stage: 'testing',
                type: 'transition.written',
                payload: { from: 'testing', to: 'review', retries: {}, by: 'runner' },
            }),
            expect.anything(),
        );
    });

    it('records a version for the transition, not just the card\u2019s current state', async () => {
        const stage = makeStage({ onPass: 'review' });

        await writeTransition(stage, baseCard, outcome({ passed: true }));

        // The append-only half of the board: `runner.cards` says where the card is now, and this
        // says how it got there — what `git log` on the board repo used to answer.
        const version = await board.currentVersion('0001');
        const row = await db.selectFrom('runner.cardVersions').select('message').where('id', '=', version!).executeTakeFirstOrThrow();
        expect(row.message).toBe('0001: testing -> review');
    });

    it('stays on its own stage and flags the card once a kicked-back card exhausts its retries', async () => {
        const stage = makeStage({ onFail: 'implementing', maxKickbacks: 1 });

        const { target, needsHuman } = await writeTransition(stage, baseCard, outcome({ passed: false }));

        expect(target).toBe('testing');
        expect(needsHuman).toBe(true);
        const stored = await board.read('0001');
        expect(stored.frontmatter.stage).toBe('testing');
        expect(stored.frontmatter.needsHuman).toBe(true);
        expect(stored.frontmatter.needsHumanReason).toContain('testing');
    });
});

/**
 * Card 0016: a transition that lands a card on a terminal state must reclaim its worktree, and a
 * transition that does not must leave it alone — a parked or merely-kicked-back card still has work
 * resuming from it. `writeTransition` is exercised the same way as above, but this time `worktrees`
 * is a spy rather than `{}`, so the reclaim call (or its absence) is an observable result rather than
 * something inferred from the try/catch swallowing an error either way.
 */
describe('StageDispatcher writeTransition reclaims the worktree on a terminal transition', () => {
    let board: BoardRepository;
    let boardRoot: string;
    let events: { append: ReturnType<typeof vi.fn> };
    let worktrees: { reclaim: ReturnType<typeof vi.fn> };
    let dispatcher: StageDispatcher;

    beforeEach(async () => {
        const base = await mkdtemp(join(tmpdir(), 'stage-dispatcher-terminal-'));
        boardRoot = join(base, 'board');

        events = { append: vi.fn(async () => {}) };
        worktrees = { reclaim: vi.fn(async () => {}) };
        const config = new StaticBoardConfig(uniqueProject(), boardRoot, join(base, 'code'), join(base, 'worktrees'), join(base, 'run'));
        board = new PostgresBoardRepository(config, db, events as unknown as EventLog);
        await board.create(baseCard, 'initial');

        dispatcher = new StageDispatcher(
            config as BoardConfig,
            board,
            worktrees as unknown as WorktreeManager,
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
                writeTransition(
                    cardId: string,
                    stageName: string,
                    stage: StageConfig,
                    card: Card,
                    outcome: StageOutcome,
                ): Promise<{ target: string; needsHuman: boolean }>;
            }
        ).writeTransition('0001', 'testing', stage, card, result);

    it('reclaims the card’s worktree and records worktree.reclaimed when the target is merged', async () => {
        const stage = makeStage({ onPass: 'merged' });

        const { target } = await writeTransition(stage, baseCard, outcome({ passed: true }));

        expect(target).toBe('merged');
        expect(worktrees.reclaim).toHaveBeenCalledTimes(1);
        expect(worktrees.reclaim).toHaveBeenCalledWith('0001');
        expect(events.append).toHaveBeenCalledWith(
            expect.objectContaining({
                cardId: '0001',
                stage: 'testing',
                type: 'worktree.reclaimed',
                payload: { cardId: '0001', target: 'merged' },
            }),
        );
    });

    it('does not reclaim when a stage exhausts its retries and flags the card, since the target is no longer terminal', async () => {
        const stage = makeStage({ onFail: 'implementing', maxKickbacks: 1 });

        const { target, needsHuman } = await writeTransition(stage, baseCard, outcome({ passed: false }));

        expect(target).toBe('testing');
        expect(needsHuman).toBe(true);
        expect(worktrees.reclaim).not.toHaveBeenCalled();
    });

    it('does not reclaim when the card advances to an ordinary, non-terminal stage', async () => {
        const stage = makeStage({ onPass: 'review' });

        const { target } = await writeTransition(stage, baseCard, outcome({ passed: true }));

        expect(target).toBe('review');
        expect(worktrees.reclaim).not.toHaveBeenCalled();
        expect(events.append).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'worktree.reclaimed' }));
    });

    it('does not reclaim when a kickback still has retries left, leaving the branch resumable', async () => {
        const stage = makeStage({ onFail: 'implementing', maxKickbacks: 3 });

        const { target } = await writeTransition(stage, baseCard, outcome({ passed: false }));

        expect(target).toBe('implementing');
        expect(worktrees.reclaim).not.toHaveBeenCalled();
    });

    it('lets the transition stand and does not append worktree.reclaimed when reclaim itself fails', async () => {
        worktrees.reclaim.mockRejectedValueOnce(new Error('boom: directory busy'));
        const stage = makeStage({ onPass: 'dropped' });

        const { target } = await writeTransition(stage, baseCard, outcome({ passed: true }));

        expect(target).toBe('dropped');
        const stored = await board.read('0001');
        expect(stored.frontmatter.stage).toBe('dropped');
        expect(events.append).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'worktree.reclaimed' }));
    });
});

/**
 * Card 0015: both adapters compute a `budgetFailure` string when a run's input tokens meet the
 * stage's cap, but that value only matters if the dispatcher actually reads it. A review of this
 * card's own implementation caught exactly that gap — `run.budgetFailure` was returned by the
 * adapters and typed on `AgentRunOutput`, but nothing in `StageDispatcher` ever looked at it, so an
 * over-budget run could still pass because the generic "no report" and truncation checks are the
 * only things that fire.
 *
 * `runAgent` (private) is exercised directly, the same way `writeTransition` is above, with a fake
 * adapter and verifier standing in for a real agent run — the point here is what the dispatcher does
 * with `run.budgetFailure`, not the agent loop that produced it.
 */
describe('StageDispatcher runAgent (via private access) surfaces a run’s budgetFailure', () => {
    const stage = makeStage({ adapter: 'api' as never, verifier: 'testing' });
    const card: Card = { ...baseCard, frontmatter: { ...baseCard.frontmatter, stage: 'testing' } };
    const scope = new ScopeGuard({ worktreeRoot: '/tmp/worktree', allow: ['**'], alwaysAllowed: [] });
    const worktree = { path: '/tmp/worktree', baseSha: 'deadbeef' } as unknown as Awaited<ReturnType<WorktreeManager['create']>>;
    const stages = { scopeViolation: 'widen' as const, alwaysAllowed: [], deny: [], stages: [stage] };

    const buildDispatcher = (adapterOutput: AgentRunOutput, verifierOutcome: VerificationOutcome) => {
        const agents = new StageAgentMap();
        agents.set('api', { run: async () => adapterOutput });
        const verifiers = new StageVerifierMap();
        const verifier: StageVerifier = { verify: async () => verifierOutcome };
        verifiers.set('testing', verifier);
        const resultSchemas = new StageResultSchemaMap();
        resultSchemas.set('testing', {} as never);

        return new StageDispatcher(
            { project: 'test' } as BoardConfig,
            {} as BoardRepository,
            {} as WorktreeManager,
            agents,
            verifiers,
            resultSchemas,
            {} as EventLog,
            silentLogger as never,
        );
    };

    const runAgent = (dispatcher: StageDispatcher) =>
        (
            dispatcher as unknown as {
                runAgent(input: {
                    card: Card;
                    stage: StageConfig;
                    worktree: typeof worktree;
                    scope: ScopeGuard;
                    planPath: string;
                    stages: typeof stages;
                }): Promise<StageOutcome>;
            }
        ).runAgent({ card, stage, worktree, scope, planPath: '/run/plan.md', stages });

    it('fails the stage on a budgetFailure even though the verifier itself passed', async () => {
        const dispatcher = buildDispatcher(
            {
                result: { summary: 'did the thing' },
                usage: { inputTokens: 5000 },
                truncated: false,
                budgetFailure: 'input token budget exceeded: used 5000, cap 1000',
            },
            { passed: true, failures: [], changedPaths: [] },
        );

        const result = await runAgent(dispatcher);

        expect(result.passed).toBe(false);
        expect(result.failures).toContain('input token budget exceeded: used 5000, cap 1000');
    });

    it('leaves a passing outcome alone when the run reports no budgetFailure', async () => {
        const dispatcher = buildDispatcher(
            { result: { summary: 'did the thing' }, usage: { inputTokens: 500 }, truncated: false },
            { passed: true, failures: [], changedPaths: [] },
        );

        const result = await runAgent(dispatcher);

        expect(result.passed).toBe(true);
        expect(result.failures).toEqual([]);
    });

    // A wall-clock or token-budget cutoff reports `truncated: true` alongside its `budgetFailure`,
    // same as ordinary step exhaustion does with `truncated: true` alone. The review's blocker was
    // that both landed together as `truncated: true` with no way to tell them apart, so the generic
    // "used all N of its steps" message was reported even when the real cause was a timeout after a
    // handful of steps. The fix — `run.truncated && !run.budgetFailure` in the dispatcher — has to be
    // checked from both sides: the step message must disappear once a budgetFailure explains the cut
    // off, and it must still appear when nothing more specific is known.
    it('reports only the budgetFailure, not the generic step-exhaustion message, when a run is both truncated and over budget', async () => {
        const dispatcher = buildDispatcher(
            {
                result: undefined,
                usage: { inputTokens: 10 },
                truncated: true,
                budgetFailure: 'wall-clock budget exceeded: cap 1800000ms',
            },
            { passed: true, failures: [], changedPaths: [] },
        );

        const result = await runAgent(dispatcher);

        expect(result.passed).toBe(false);
        expect(result.failures).toContain('wall-clock budget exceeded: cap 1800000ms');
        expect(result.failures.some(f => f.includes('used all'))).toBe(false);
    });

    it('still reports the generic step-exhaustion message when a run is truncated with no more specific cause known', async () => {
        const dispatcher = buildDispatcher(
            { result: undefined, usage: { inputTokens: 10 }, truncated: true },
            { passed: true, failures: [], changedPaths: [] },
        );

        const result = await runAgent(dispatcher);

        expect(result.passed).toBe(false);
        expect(result.failures.some(f => f.includes(`used all ${stage.maxSteps} of its steps`))).toBe(true);
    });
});
