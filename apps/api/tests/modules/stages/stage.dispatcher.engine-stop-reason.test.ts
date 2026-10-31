import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { StageDispatcher } from '#modules/stages/stage.dispatcher.js';
import { StaticStageConfigStore } from '#modules/stages/stage.config.store.js';
import { BoardRepository } from '#modules/board/board.repository.js';
import { PostgresBoardRepository } from '#modules/board/postgres.board.repository.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { StageAgentMap, type AgentRunOutput } from '#modules/agent/stage.agent.js';
import { StageVerifierMap, type StageVerifier } from '#modules/stages/stage.verifier.js';
import { StageResultSchemaMap } from '#modules/stages/stage.result.js';
import type { Card } from '#modules/board/card.js';
import type { EventLog } from '#modules/events/event.log.js';
import type { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import type { Kysely } from 'kysely';
import type { DB } from '#modules/data/db.js';

const exec = promisify(execFile);
const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

const stagesYaml = `
stages:
  - name: testing
    mode: agent
    model: claude-opus
    instructions: test it
    onPass: merged
    onFail: testing
`;

const card: Card = {
    frontmatter: {
        id: '0001',
        title: 'do the thing',
        stage: 'testing',
        dependsOn: [],
        retries: {},
    },
    sections: { 'Files in scope': '- src/x.ts' },
    body: '## Goal\n\nDo the thing.\n\n## Files in scope\n\n- src/x.ts\n',
};

/**
 * Card 0118: a stage that ends without ever calling `report_result` used to fail with no record of
 * why the engine stopped. `AgentRunOutput.engineStopReason` — set by `cli.stage.agent.ts` off the
 * SDK's own `result` message — is meant to land on the existing `stage.failed` event, alongside
 * `failures`/`usage`, not as a new event of its own (the card's "attach it to the existing failure"
 * constraint). This exercises `StageDispatcher.run`'s public path end to end, the same way
 * `stage.dispatcher.preserve-on-fail.test.ts` exercises `patchPath` on the same event, so what's
 * under test is specifically what the dispatcher does with the field once the adapter sets it — the
 * adapter's own half is `cli.engine-stop-reason.test.ts`.
 */
describe('StageDispatcher.run records the engine’s stop reason on stage.failed (card 0118)', () => {
    const setUp = async () => {
        const base = await mkdtemp(join(tmpdir(), 'stage-dispatcher-engine-stop-reason-'));

        const worktreeDir = join(base, 'worktree');
        await mkdir(worktreeDir, { recursive: true });
        await exec('git', ['init'], { cwd: worktreeDir });
        await mkdir(join(worktreeDir, 'src'), { recursive: true });
        await writeFile(join(worktreeDir, 'src', 'x.ts'), 'export const x = 1;\n', 'utf8');

        const config = new StaticBoardConfig(uniqueProject(), join(base, 'code'), join(base, 'worktrees'), join(base, 'run'));
        const events = { append: vi.fn(async () => {}) };
        const board: BoardRepository = new PostgresBoardRepository(config, db, events as unknown as EventLog);
        await board.create(card, 'initial');

        const worktrees = {
            resolveBranch: vi.fn(() => 'card/0001-do-the-thing'),
            hasWork: vi.fn(async () => false),
            create: vi.fn(async () => ({ path: worktreeDir, baseSha: 'deadbeef' })),
            resume: vi.fn(async () => {
                throw new Error('MARKER: should not resume — hasWork returned false');
            }),
            rebaseOntoHead: vi.fn(async () => {
                throw new Error('MARKER: should not rebase — the run is not resumable');
            }),
            commit: vi.fn(async () => 'committedsha'),
            reclaim: vi.fn(async () => {}),
            failedAttemptPatchPath: vi.fn((cardId: string) => join(base, 'run', 'cards', cardId, 'last-failed-attempt.patch')),
        };

        return { config, board, worktrees, events };
    };

    const buildDispatcher = (
        config: StaticBoardConfig,
        board: BoardRepository,
        worktrees: unknown,
        events: { append: ReturnType<typeof vi.fn> },
        run: () => Promise<AgentRunOutput>,
        verify: StageVerifier['verify'],
    ) => {
        const agents = new StageAgentMap();
        agents.set('api', { run });

        const verifiers = new StageVerifierMap();
        verifiers.set('testing', { verify });

        const resultSchemas = new StageResultSchemaMap();
        resultSchemas.set('testing', {} as never);

        return new StageDispatcher(
            config,
            new StaticStageConfigStore(stagesYaml),
            board,
            worktrees as unknown as WorktreeManager,
            agents,
            verifiers,
            resultSchemas,
            events as unknown as EventLog,
            silentLogger as never,
        );
    };

    it('carries the run’s trace onto its end event', async () => {
        const { config, board, worktrees, events } = await setUp();
        const trace = { reads: 2, readPaths: ['src/x.ts'], finalMessage: 'stopped here' };
        const dispatcher = buildDispatcher(
            config,
            board,
            worktrees,
            events,
            async () => ({ result: undefined, truncated: true, trace }),
            async () => ({ passed: true, failures: [], changedPaths: [] }),
        );

        await dispatcher.run('0001', 'testing');

        expect(events.append).toHaveBeenCalledWith(expect.objectContaining({ type: 'stage.failed', payload: expect.objectContaining({ trace }) }));
    });

    it('carries the engine’s stop reason onto stage.failed when the run ended with nothing reported', async () => {
        const { config, board, worktrees, events } = await setUp();
        const dispatcher = buildDispatcher(
            config,
            board,
            worktrees,
            events,
            async () => ({
                result: undefined,
                usage: { inputTokens: 10 },
                truncated: false,
                engineStopReason: "ended as 'success' (stop_reason: end_turn)",
            }),
            async () => ({ passed: true, failures: [], changedPaths: [] }),
        );

        const result = await dispatcher.run('0001', 'testing');

        expect(result.passed).toBe(false);
        expect(events.append).toHaveBeenCalledWith(
            expect.objectContaining({
                cardId: '0001',
                stage: 'testing',
                type: 'stage.failed',
                payload: expect.objectContaining({ engineStopReason: "ended as 'success' (stop_reason: end_turn)" }),
            }),
        );
    });

    it('names no reason on stage.failed when the adapter run gave none — the stream simply closed', async () => {
        const { config, board, worktrees, events } = await setUp();
        const dispatcher = buildDispatcher(
            config,
            board,
            worktrees,
            events,
            async () => ({ result: undefined, usage: { inputTokens: 10 }, truncated: false }),
            async () => ({ passed: true, failures: [], changedPaths: [] }),
        );

        const result = await dispatcher.run('0001', 'testing');

        expect(result.passed).toBe(false);
        const failedCall = events.append.mock.calls.find(([evt]) => evt.type === 'stage.failed');
        expect(failedCall).toBeDefined();
        expect(failedCall![0].payload).not.toHaveProperty('engineStopReason');
    });

    it('does not put an engineStopReason on stage.passed, even when the adapter run happened to carry one', async () => {
        const { config, board, worktrees, events } = await setUp();
        const dispatcher = buildDispatcher(
            config,
            board,
            worktrees,
            events,
            async () => ({
                result: { summary: 'did the thing', caveats: [] },
                usage: { inputTokens: 10 },
                truncated: false,
                // A passing run should never carry one in practice (cli.stage.agent.ts only sets it
                // on a failing path), but the dispatcher's own job is not to trust that — a passing
                // outcome must stay exactly as quiet as it was before this card regardless.
                engineStopReason: "ended as 'success' (stop_reason: end_turn)",
            }),
            async () => ({ passed: true, failures: [], changedPaths: [] }),
        );

        const result = await dispatcher.run('0001', 'testing');

        expect(result.passed).toBe(true);
        const passedCall = events.append.mock.calls.find(([evt]) => evt.type === 'stage.passed');
        expect(passedCall).toBeDefined();
        expect(passedCall![0].payload).not.toHaveProperty('engineStopReason');
    });
});
