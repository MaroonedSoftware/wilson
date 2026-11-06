import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Kysely } from 'kysely';
import { StageDispatcher } from '#modules/stages/stage.dispatcher.js';
import { PostgresBoardRepository } from '#modules/board/postgres.board.repository.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { ScopeGuard } from '#modules/agent/scope.guard.js';
import { StageAgentMap, type AgentRunOutput } from '#modules/agent/stage.agent.js';
import { StageVerifierMap } from '#modules/stages/stage.verifier.js';
import { StageResultSchemaMap, type StageOutcome } from '#modules/stages/stage.result.js';
import type { Card } from '#modules/board/card.js';
import type { StageConfig } from '#modules/stages/stage.config.js';
import type { StageConfigStore } from '#modules/stages/stage.config.store.js';
import type { EventLog } from '#modules/events/event.log.js';
import type { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import type { DB } from '#modules/data/db.js';
import { stageDefaults } from '#tests/modules/stages/stage.fixture.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';

/**
 * A failure of the process around a stage, rather than of the stage, holds the card with its retries
 * as they were. The engine API error here is the live board's case: an engine too old for its model
 * ends every turn on "API Error: 400" within seconds, and counting each one as a kickback spent a
 * card's whole budget before anyone looked.
 */
let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const API_ERROR = 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"model not supported"}}';

const stage: StageConfig = {
    ...stageDefaults,
    name: 'implementing',
    mode: 'agent',
    worktree: 'rw',
    adapter: 'api' as never,
    provider: 'anthropic',
    model: 'claude-opus',
    instructions: 'do it',
    allowedCommands: [],
    worktreeFrom: 'branch',
    extraScope: [],
    baselineCheck: true,
    maxSteps: 60,
    maxOutputTokens: 16000,
    onPass: 'review',
    onFail: 'implementing',
    maxKickbacks: 3,
};

const card: Card = {
    frontmatter: { id: '0001', title: 'do the thing', stage: 'implementing', dependsOn: [], retries: { implementing: 2 } },
    sections: {},
    body: '## Goal\n\nDo the thing.',
};

describe('StageDispatcher holds a card for an engine API error', () => {
    let board: PostgresBoardRepository;
    let dispatcher: StageDispatcher;
    let events: { append: ReturnType<typeof vi.fn> };

    const build = async (output: AgentRunOutput) => {
        const base = await mkdtemp(join(tmpdir(), 'stage-dispatcher-process-failure-'));
        events = { append: vi.fn(async () => {}) };
        const config = new StaticBoardConfig(uniqueProject(), join(base, 'code'), join(base, 'worktrees'), join(base, 'run'));
        board = new PostgresBoardRepository(config, db, events as unknown as EventLog);
        await board.create(card, 'initial');

        const agents = new StageAgentMap();
        agents.set('api', { run: async () => output });
        const verifiers = new StageVerifierMap();
        verifiers.set('implementing', { verify: async () => ({ passed: false, failures: ['the diff is empty'], changedPaths: [] }) });
        const resultSchemas = new StageResultSchemaMap();
        resultSchemas.set('implementing', z.object({ summary: z.string() }));

        dispatcher = new StageDispatcher(
            config,
            {} as StageConfigStore,
            board,
            {
                uncommittedSnapshot: async () => ({}),
                failedAttemptPatchPath: (cardId: string) => join(base, 'run', cardId, 'last-failed-attempt.patch'),
            } as unknown as WorktreeManager,
            agents,
            verifiers,
            resultSchemas,
            events as unknown as EventLog,
            silentLogger as never,
        );
    };

    const runAgent = (): Promise<StageOutcome> => {
        const worktree = { path: '/tmp/worktree', baseSha: 'deadbeef' };
        const scope = new ScopeGuard({ worktreeRoot: '/tmp/worktree', allow: ['**'], alwaysAllowed: [] });
        const stages = { scopeViolation: 'widen' as const, alwaysAllowed: [], deny: [], stages: [stage] };
        return (dispatcher as unknown as { runAgent(input: unknown): Promise<StageOutcome> }).runAgent({
            card,
            stage,
            worktree,
            scope,
            planPath: '/run/plan.md',
            stages,
        });
    };

    const writeTransition = (outcome: StageOutcome) =>
        (
            dispatcher as unknown as {
                writeTransition(id: string, name: string, s: StageConfig, head: Card, c: Card, o: StageOutcome): Promise<{ target: string }>;
            }
        ).writeTransition('0001', 'implementing', stage, card, card, outcome);

    beforeEach(async () => {
        await build({ usage: { inputTokens: 3 }, truncated: false, engineApiError: API_ERROR });
    });

    it('classes the failure as the engine API and leads with its words', async () => {
        const outcome = await runAgent();

        expect(outcome.passed).toBe(false);
        expect(outcome.unjudged).toBe(true);
        expect(outcome.failureClass).toBe('engineApi');
        expect(outcome.failures[0]).toContain('API Error: 400');
        expect(outcome.processFailure).toContain('model not supported');
    });

    it('flags the card where it is without spending a retry, though one more failure would reach its cap', async () => {
        const { target } = await writeTransition(await runAgent());

        expect(target).toBe('implementing');
        const stored = await board.read('0001');
        expect(stored.frontmatter.stage).toBe('implementing');
        expect(stored.frontmatter.retries).toEqual({ implementing: 2 });
        expect(stored.frontmatter.needsHuman).toBe(true);
        expect(stored.frontmatter.needsHumanReason).toMatch(/held, with no retry spent: .*API Error: 400/);
        const transition = events.append.mock.calls.map(([event]) => event as { type: string; payload: Record<string, unknown> }).at(-1);
        expect(transition?.payload).toMatchObject({ failureClass: 'engineApi', needsHuman: true, retries: { implementing: 2 } });
    });

    it('still counts an ordinary unjudged failure against the card', async () => {
        await build({ usage: {}, truncated: true, engineFailure: 'the engine stopped responding' });

        await writeTransition(await runAgent());

        const stored = await board.read('0001');
        expect(stored.frontmatter.retries).toEqual({ implementing: 3 });
        expect(stored.frontmatter.needsHumanReason).toMatch(/maxKickbacks/);
    });
});
