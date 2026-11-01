import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
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
import { stageDefaults } from '#tests/modules/stages/stage.fixture.js';
import type { StageConfigStore } from '#modules/stages/stage.config.store.js';
import type { StageOutcome } from '#modules/stages/stage.result.js';
import type { EventLog } from '#modules/events/event.log.js';
import type { BoardConfig } from '#modules/board/board.config.js';
import type { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import type { Kysely } from 'kysely';
import type { DB } from '#modules/data/db.js';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

// Same reasoning as stage.dispatcher.test.ts: a real Postgres board, not a mock of `write`, so the
// card actually observed on disk is what is asserted on.
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
    ...stageDefaults,
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
 * Card 0082's whole point: `kickback` cannot see the run's own outcome unless `writeTransition`
 * passes it along. These exercise `writeTransition` the same way `stage.dispatcher.test.ts` already
 * does — through a real board — but with `outcome.unjudged` set, to check the routing decision this
 * card actually changed rather than the routing decision that already worked before it.
 */
describe('StageDispatcher writeTransition routes an unjudged failure to the stage itself (card 0082)', () => {
    let board: BoardRepository;
    let dispatcher: StageDispatcher;

    beforeEach(async () => {
        const base = await mkdtemp(join(tmpdir(), 'stage-dispatcher-unjudged-'));

        const events = { append: vi.fn(async () => {}) };
        const config = new StaticBoardConfig(uniqueProject(), join(base, 'code'), join(base, 'worktrees'), join(base, 'run'));
        board = new PostgresBoardRepository(config, db, events as unknown as EventLog);
        await board.create(baseCard, 'initial');

        // Card 0234: a judged failure now calls `failedAttemptPatchPath` unconditionally while
        // building its attempts bullet, so the worktrees stub needs a real function here — the
        // "still judged" tests below hit exactly that branch.
        const worktrees = { failedAttemptPatchPath: (cardId: string) => join(config.runRoot, 'cards', cardId, 'last-failed-attempt.patch') };

        dispatcher = new StageDispatcher(
            config as BoardConfig,
            {} as StageConfigStore,
            board,
            worktrees as unknown as WorktreeManager,
            {} as StageAgentMap,
            {} as StageVerifierMap,
            {} as StageResultSchemaMap,
            events as unknown as EventLog,
            silentLogger as never,
        );
    });

    const writeTransition = (stage: StageConfig, card: Card, result: StageOutcome, head: Card = card) =>
        (
            dispatcher as unknown as {
                writeTransition(
                    cardId: string,
                    stageName: string,
                    stage: StageConfig,
                    head: Card,
                    card: Card,
                    outcome: StageOutcome,
                ): Promise<{ target: string; needsHuman: boolean }>;
            }
        ).writeTransition('0001', 'review', stage, head, card, result);

    it('routes a review that never reached a verdict back to review, not to onFail — card 0075’s shape', async () => {
        const stage = makeStage({ name: 'review', onPass: 'merge', onFail: 'implementing', maxKickbacks: 3 });
        const card: Card = { ...baseCard, frontmatter: { ...baseCard.frontmatter, stage: 'review' } };

        const { target } = await writeTransition(stage, card, outcome({ passed: false, unjudged: true }));

        expect(target).toBe('review');
        const stored = await board.read('0001');
        expect(stored.frontmatter.stage).toBe('review');
        expect(stored.frontmatter.retries).toEqual({ review: 1 });
        expect(stored.frontmatter.needsHuman).toBeFalsy();
    });

    it('still sends a judged review failure — a real blocker — to implementing', async () => {
        const stage = makeStage({ name: 'review', onPass: 'merge', onFail: 'implementing', maxKickbacks: 3 });
        const card: Card = { ...baseCard, frontmatter: { ...baseCard.frontmatter, stage: 'review' } };

        const { target } = await writeTransition(stage, card, outcome({ passed: false, unjudged: false }));

        expect(target).toBe('implementing');
        const stored = await board.read('0001');
        expect(stored.frontmatter.stage).toBe('implementing');
    });

    it('treats an outcome with no unjudged field at all the same as unjudged: false — the default stays "judged"', async () => {
        const stage = makeStage({ name: 'review', onPass: 'merge', onFail: 'implementing', maxKickbacks: 3 });
        const card: Card = { ...baseCard, frontmatter: { ...baseCard.frontmatter, stage: 'review' } };

        const { target } = await writeTransition(stage, card, outcome({ passed: false }));

        expect(target).toBe('implementing');
    });

    it('still bounds a self-routed unjudged failure by maxKickbacks and flags the card once exhausted', async () => {
        const stage = makeStage({ name: 'review', onPass: 'merge', onFail: 'implementing', maxKickbacks: 1 });
        const card: Card = { ...baseCard, frontmatter: { ...baseCard.frontmatter, stage: 'review' } };

        const { target, needsHuman } = await writeTransition(stage, card, outcome({ passed: false, unjudged: true }));

        expect(target).toBe('review');
        expect(needsHuman).toBe(true);
        const stored = await board.read('0001');
        expect(stored.frontmatter.stage).toBe('review');
        expect(stored.frontmatter.needsHuman).toBe(true);
        expect(stored.frontmatter.needsHumanReason).toContain('review');
    });
});

/**
 * `runAgent` (private, exercised the same way `stage.dispatcher.budget.test.ts` already does) is
 * where `unjudged` is actually computed, from the run's own signals — not from the verifier's
 * judgment of the code. A real Zod schema stands in for the stage's result schema here, since the
 * schema-invalid case needs `safeParse` to actually run.
 */
describe('StageDispatcher runAgent (via private access) computes unjudged from the run’s own outcome (card 0082)', () => {
    const stage = makeStage({ name: 'testing', adapter: 'api' as never, verifier: 'testing', maxSteps: 60 });
    const card: Card = { ...baseCard, frontmatter: { ...baseCard.frontmatter, stage: 'testing' } };
    const scope = new ScopeGuard({ worktreeRoot: '/tmp/worktree', allow: ['**'], alwaysAllowed: [] });
    const worktree = { path: '/tmp/worktree', baseSha: 'deadbeef' } as unknown as Awaited<ReturnType<WorktreeManager['create']>>;
    const stages = { scopeViolation: 'widen' as const, alwaysAllowed: [], deny: [], stages: [stage] };

    // A minimal stand-in for a stage's real result schema — the point is that `safeParse` runs for
    // real, not what shape a testing result actually has.
    const testResultSchema = z.object({ summary: z.string(), filesTouched: z.array(z.string()) });

    const buildDispatcher = (adapterOutput: AgentRunOutput, verifierOutcome: VerificationOutcome) => {
        const agents = new StageAgentMap();
        agents.set('api', { run: async () => adapterOutput });
        const verifiers = new StageVerifierMap();
        const verifier: StageVerifier = { verify: async () => verifierOutcome };
        verifiers.set('testing', verifier);
        const resultSchemas = new StageResultSchemaMap();
        resultSchemas.set('testing', testResultSchema);

        return new StageDispatcher(
            { project: 'test' } as BoardConfig,
            {} as StageConfigStore,
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

    it('marks a run that never called the report tool as unjudged', async () => {
        const dispatcher = buildDispatcher({ result: undefined, usage: {}, truncated: false }, { passed: true, failures: [], changedPaths: [] });

        const result = await runAgent(dispatcher);

        expect(result.passed).toBe(false);
        expect(result.unjudged).toBe(true);
    });

    it('marks a step-exhausted, truncated run as unjudged, whatever the verifier itself thought', async () => {
        const dispatcher = buildDispatcher(
            { result: { summary: 'did it', filesTouched: [] }, usage: {}, truncated: true },
            { passed: true, failures: [], changedPaths: [] },
        );

        const result = await runAgent(dispatcher);

        expect(result.passed).toBe(false);
        expect(result.unjudged).toBe(true);
    });

    it('marks a wall-clock/budget cutoff as unjudged', async () => {
        const dispatcher = buildDispatcher(
            { result: undefined, usage: {}, truncated: true, budgetFailure: 'wall-clock budget exceeded: cap 1800000ms' },
            { passed: true, failures: [], changedPaths: [] },
        );

        const result = await runAgent(dispatcher);

        expect(result.passed).toBe(false);
        expect(result.unjudged).toBe(true);
    });

    it('marks an engine failure as unjudged', async () => {
        const dispatcher = buildDispatcher(
            { result: undefined, usage: {}, truncated: false, engineFailure: 'the engine stopped responding' },
            { passed: true, failures: [], changedPaths: [] },
        );

        const result = await runAgent(dispatcher);

        expect(result.passed).toBe(false);
        expect(result.unjudged).toBe(true);
    });

    // The step-budget review case from card 0075's own shape: the run reported *something*, but not
    // something that matched the stage's own schema, so there was nothing coherent to judge. A
    // schema-invalid result on its own carries no failure — it takes the verifier's own rejection
    // (exactly what a real ReviewVerifier does with a hallucinated result) for this to matter, and
    // `unjudged` is what tells that rejection apart from a verifier judging well-formed work and
    // finding it wanting.
    it('marks a verifier’s rejection as unjudged when the reported result never matched its own schema', async () => {
        const dispatcher = buildDispatcher(
            { result: { summary: 'did it' }, usage: {}, truncated: false },
            { passed: false, failures: ['the reported result does not match the review schema'], changedPaths: [] },
        );

        const result = await runAgent(dispatcher);

        expect(result.passed).toBe(false);
        expect(result.unjudged).toBe(true);
    });

    it('leaves a verifier’s rejection judged when the result matches its schema — an empty diff is a verdict on the code', async () => {
        const dispatcher = buildDispatcher(
            { result: { summary: 'did it', filesTouched: [] }, usage: {}, truncated: false },
            { passed: false, failures: ['diff is empty'], changedPaths: [] },
        );

        const result = await runAgent(dispatcher);

        expect(result.passed).toBe(false);
        expect(result.unjudged).toBe(false);
    });

    it('reports unjudged as false, not merely absent, on a passing outcome', async () => {
        const dispatcher = buildDispatcher(
            { result: { summary: 'did it', filesTouched: [] }, usage: {}, truncated: false },
            { passed: true, failures: [], changedPaths: [] },
        );

        const result = await runAgent(dispatcher);

        expect(result.passed).toBe(true);
        expect(result.unjudged).toBe(false);
    });
});
