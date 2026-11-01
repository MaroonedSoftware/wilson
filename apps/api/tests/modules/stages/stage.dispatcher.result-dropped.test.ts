import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { StageDispatcher } from '#modules/stages/stage.dispatcher.js';
import { BoardRepository } from '#modules/board/board.repository.js';
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

/**
 * `runAgent` (private, exercised the same way `stage.dispatcher.unjudged.test.ts` already does) is
 * where `AgentRunOutput.resultDropped` is read off the adapter's run and both carried onto
 * `StageOutcome.resultDropped` and turned into the failure message an operator actually reads. Card
 * 0092's whole point is that this message, and the accounting `kickback` does with it, differ from a
 * plain "never reported" — so these check the dispatcher's half of that distinction, not the
 * `cli.stage.agent.ts` half already covered by `cli.result-dropped.test.ts`.
 */
describe('StageDispatcher runAgent — resultDropped (card 0092)', () => {
    const stage = makeStage({ name: 'testing', adapter: 'api' as never, verifier: 'testing', maxSteps: 60 });
    const card: Card = { ...baseCard, frontmatter: { ...baseCard.frontmatter, stage: 'testing' } };
    const scope = new ScopeGuard({ worktreeRoot: '/tmp/worktree', allow: ['**'], alwaysAllowed: [] });
    const worktree = { path: '/tmp/worktree', baseSha: 'deadbeef' } as unknown as Awaited<ReturnType<WorktreeManager['create']>>;
    const stages = { scopeViolation: 'widen' as const, alwaysAllowed: [], deny: [], stages: [stage] };

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

    it('carries resultDropped from the adapter run onto the outcome', async () => {
        const dispatcher = buildDispatcher(
            { result: undefined, usage: {}, truncated: false, resultDropped: true },
            { passed: true, failures: [], changedPaths: [] },
        );

        const result = await runAgent(dispatcher);

        expect(result.passed).toBe(false);
        expect(result.unjudged).toBe(true);
        expect(result.resultDropped).toBe(true);
    });

    it('says the result was lost, not that the stage never reported, when resultDropped is set', async () => {
        const dispatcher = buildDispatcher(
            { result: undefined, usage: {}, truncated: false, resultDropped: true },
            { passed: true, failures: [], changedPaths: [] },
        );

        const result = await runAgent(dispatcher);

        expect(result.failures[0]).toMatch(/result did not arrive/);
        expect(result.failures[0]).not.toMatch(/never reported finishing/);
    });

    it('keeps the original "never reported finishing" message when the report tool was never seen at all', async () => {
        const dispatcher = buildDispatcher({ result: undefined, usage: {}, truncated: false }, { passed: true, failures: [], changedPaths: [] });

        const result = await runAgent(dispatcher);

        expect(result.failures[0]).toMatch(/never reported finishing/);
        expect(result.resultDropped).toBeFalsy();
    });

    it('reports resultDropped as false, not merely absent, on a passing outcome', async () => {
        const dispatcher = buildDispatcher(
            { result: { summary: 'did it', filesTouched: [] }, usage: {}, truncated: false, resultDropped: false },
            { passed: true, failures: [], changedPaths: [] },
        );

        const result = await runAgent(dispatcher);

        expect(result.passed).toBe(true);
        expect(result.resultDropped).toBe(false);
    });
});
