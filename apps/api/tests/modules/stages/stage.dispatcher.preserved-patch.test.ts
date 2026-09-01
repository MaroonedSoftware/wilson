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
import { StageAgentMap, type AgentRunInput, type AgentRunOutput } from '#modules/agent/stage.agent.js';
import { StageVerifierMap, type StageVerifier } from '#modules/stages/stage.verifier.js';
import { StageResultSchemaMap } from '#modules/stages/stage.result.js';
import type { ScopeDecision } from '#modules/agent/scope.guard.js';
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

const cardFor = (id: string): Card => ({
    frontmatter: {
        id,
        title: `card ${id}`,
        stage: 'testing',
        dependsOn: [],
        retries: {},
    },
    sections: { 'Files in scope': '- src/x.ts' },
    body: '## Goal\n\nDo the thing.\n\n## Files in scope\n\n- src/x.ts\n',
});

/**
 * Card 0161: `ScopeGuard.checkRead` refused a stage's read of a preserved
 * `last-failed-attempt.patch` — even one its own plan named — because the file lives outside the
 * worktree (`WorktreeManager.failedAttemptPatchPath`, `<runRoot>/cards/<id>/last-failed-attempt.patch`)
 * and `readableExtras` carried only the plan. Card 0154's plan named *card 0151's* patch, not its
 * own, and split cards inheriting a parent's preserved attempt is the normal case — so the fix has
 * to cover every card on the board, not just the one dispatching.
 *
 * `StageDispatcher.run` now derives `preservedPatchPaths` from `boardCards` (fetched for
 * `assertDispatchable` already) via `WorktreeManager.failedAttemptPatchPath`, and folds them into
 * `readableExtras` alongside `planPath`. This drives that through a real `run()`, the same
 * probing-adapter shape `stage.dispatcher.collateral.test.ts` uses: the stub agent calls
 * `context.scope.checkRead`/`check` itself and hands the real decisions back out, so the assertions
 * are against the actual `ScopeGuard` the dispatcher built — not a re-implementation of its logic.
 */
describe('StageDispatcher.run grants read access to every board card\'s preserved patch (card 0161)', () => {
    const setUp = async () => {
        const base = await mkdtemp(join(tmpdir(), 'stage-dispatcher-preserved-patch-'));
        const boardRoot = join(base, 'board');
        await mkdir(join(boardRoot, 'cards'), { recursive: true });

        const worktreeDir = join(base, 'worktree');
        await mkdir(worktreeDir, { recursive: true });
        await exec('git', ['init'], { cwd: worktreeDir });
        await mkdir(join(worktreeDir, 'src'), { recursive: true });
        await writeFile(join(worktreeDir, 'src', 'x.ts'), 'export const x = 1;\n', 'utf8');

        const config = new StaticBoardConfig(uniqueProject(), boardRoot, join(base, 'code'), join(base, 'worktrees'), join(base, 'run'));
        const events = { append: vi.fn(async () => {}) };
        const board: BoardRepository = new PostgresBoardRepository(config, db, events as unknown as EventLog);
        // Two cards on the board: 0001 is the one being dispatched, 0002 is unrelated — the case
        // that actually mattered (0154 was refused 0151's patch, not its own).
        await board.create(cardFor('0001'), 'initial');
        await board.create(cardFor('0002'), 'initial');

        const failedAttemptPatchPath = (cardId: string) => join(config.runRoot, 'cards', cardId, 'last-failed-attempt.patch');

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
            failedAttemptPatchPath,
        };

        return { config, board, worktrees, failedAttemptPatchPath, events };
    };

    const buildDispatcherWithProbingAdapter = (
        config: StaticBoardConfig,
        board: BoardRepository,
        worktrees: unknown,
        events: { append: ReturnType<typeof vi.fn> },
        probe: (input: AgentRunInput) => Promise<void>,
    ) => {
        const agents = new StageAgentMap();
        agents.set('api', {
            run: async (input: AgentRunInput): Promise<AgentRunOutput> => {
                await probe(input);
                return { result: { summary: 'did the thing', caveats: [] }, usage: { inputTokens: 10 }, truncated: false };
            },
        });

        const verifiers = new StageVerifierMap();
        const verifier: StageVerifier = { verify: async () => ({ passed: true, failures: [], changedPaths: [] }) };
        verifiers.set('testing', verifier);

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

    it("allows reading another card's preserved patch, the exact case cards 0154 and 0155 were refused", async () => {
        const { config, board, worktrees, failedAttemptPatchPath, events } = await setUp();

        let decision: ScopeDecision | undefined;
        const dispatcher = buildDispatcherWithProbingAdapter(config, board, worktrees, events, async input => {
            // 0002's patch was never written to disk — card 0001 is running, not 0002 — but the
            // grant does not depend on the file existing (see the third test below).
            decision = await input.context.scope.checkRead(failedAttemptPatchPath('0002'));
        });

        const result = await dispatcher.run('0001', 'testing');

        expect(result.passed).toBe(true);
        expect(decision).toMatchObject({ allowed: true, path: failedAttemptPatchPath('0002') });
    });

    it("also allows reading the running card's own preserved patch", async () => {
        const { config, board, worktrees, failedAttemptPatchPath, events } = await setUp();

        let decision: ScopeDecision | undefined;
        const dispatcher = buildDispatcherWithProbingAdapter(config, board, worktrees, events, async input => {
            decision = await input.context.scope.checkRead(failedAttemptPatchPath('0001'));
        });

        const result = await dispatcher.run('0001', 'testing');

        expect(result.passed).toBe(true);
        expect(decision).toMatchObject({ allowed: true });
    });

    it('grants the pattern unconditionally: a patch for a card that never failed reads as allowed, not as a scope refusal', async () => {
        const { config, board, worktrees, failedAttemptPatchPath, events } = await setUp();

        // Neither card has an actual patch file on disk anywhere in this test — this asserts the
        // grant itself does not depend on the file existing, which is what lets an absent patch
        // surface later as an ordinary missing-file read rather than a scope denial.
        let decision: ScopeDecision | undefined;
        const dispatcher = buildDispatcherWithProbingAdapter(config, board, worktrees, events, async input => {
            decision = await input.context.scope.checkRead(failedAttemptPatchPath('0002'));
        });

        await dispatcher.run('0001', 'testing');

        expect(decision?.allowed).toBe(true);
    });

    it('still refuses a read of some other path under runRoot that is neither the plan nor a preserved patch', async () => {
        const { config, board, worktrees, events } = await setUp();

        let decision: ScopeDecision | undefined;
        const dispatcher = buildDispatcherWithProbingAdapter(config, board, worktrees, events, async input => {
            decision = await input.context.scope.checkRead(join(config.runRoot, 'cards', '0002', 'some-other-file.txt'));
        });

        const result = await dispatcher.run('0001', 'testing');

        expect(result.passed).toBe(true);
        expect(decision).toMatchObject({ allowed: false });
    });

    it('never makes a preserved patch writable, even though it is readable', async () => {
        const { config, board, worktrees, failedAttemptPatchPath, events } = await setUp();

        let decision: ScopeDecision | undefined;
        const dispatcher = buildDispatcherWithProbingAdapter(config, board, worktrees, events, async input => {
            decision = await input.context.scope.check(failedAttemptPatchPath('0002'));
        });

        const result = await dispatcher.run('0001', 'testing');

        expect(result.passed).toBe(true);
        expect(decision).toMatchObject({ allowed: false });
    });
});
