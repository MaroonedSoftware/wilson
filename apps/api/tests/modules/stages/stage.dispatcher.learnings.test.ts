import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
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
import { StaticLearningsStore } from '#modules/learnings/learnings.store.js';
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
 * Card 0244: `StageDispatcher.run` now materializes the project's learnings document (if the
 * `LearningsStore` it was constructed with has one) to `<runRoot>/cards/<id>/learnings.md` — outside
 * the worktree, the same way the plan and a preserved patch are — and grants a stage's `ScopeGuard`
 * read access to it via `readableExtras`, passing the path to the adapter as `learningsPath`.
 *
 * An empty or absent document means "no learnings" (PROJECT.md decision 8): no file is written, no
 * path is granted, and the adapter's input carries no `learningsPath` at all — asserted here against
 * the same probing-adapter shape `stage.dispatcher.preserved-patch.test.ts` uses, so the checks run
 * against the dispatcher's real `ScopeGuard`, not a re-implementation of its logic.
 */
describe('StageDispatcher.run materializes the project learnings document (card 0244)', () => {
    const setUp = async (learnings?: StaticLearningsStore) => {
        const base = await mkdtemp(join(tmpdir(), 'stage-dispatcher-learnings-'));

        const worktreeDir = join(base, 'worktree');
        await mkdir(worktreeDir, { recursive: true });
        await exec('git', ['init'], { cwd: worktreeDir });
        await mkdir(join(worktreeDir, 'src'), { recursive: true });
        await writeFile(join(worktreeDir, 'src', 'x.ts'), 'export const x = 1;\n', 'utf8');

        const config = new StaticBoardConfig(uniqueProject(), join(base, 'code'), join(base, 'worktrees'), join(base, 'run'));
        const events = { append: vi.fn(async () => {}) };
        const board: BoardRepository = new PostgresBoardRepository(config, db, events as unknown as EventLog);
        await board.create(cardFor('0001'), 'initial');

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
            failedAttemptPatchPath: (cardId: string) => join(config.runRoot, 'cards', cardId, 'last-failed-attempt.patch'),
        };

        const learningsPath = join(config.runRoot, 'cards', '0001', 'learnings.md');

        return { config, board, worktrees, events, learningsPath };
    };

    const buildDispatcher = (
        config: StaticBoardConfig,
        board: BoardRepository,
        worktrees: unknown,
        events: { append: ReturnType<typeof vi.fn> },
        probe: (input: AgentRunInput) => Promise<void>,
        learnings?: StaticLearningsStore,
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
            undefined,
            undefined,
            learnings as never,
        );
    };

    it('AC1: writes the non-empty document to <runRoot>/cards/<id>/learnings.md, grants a stage read access to it, and hands the path to the adapter', async () => {
        const { config, board, worktrees, events, learningsPath } = await setUp();
        const learnings = new StaticLearningsStore('# Lessons\n\nAlways run the build before reporting.\n');

        let capturedInput: AgentRunInput | undefined;
        let decision: ScopeDecision | undefined;
        const dispatcher = buildDispatcher(
            config,
            board,
            worktrees,
            events,
            async input => {
                capturedInput = input;
                decision = await input.context.scope.checkRead(learningsPath);
            },
            learnings,
        );

        const result = await dispatcher.run('0001', 'testing');

        expect(result.passed).toBe(true);
        expect(existsSync(learningsPath)).toBe(true);
        expect(await readFile(learningsPath, 'utf8')).toBe('# Lessons\n\nAlways run the build before reporting.\n');
        expect(decision).toMatchObject({ allowed: true, path: learningsPath });
        expect(capturedInput?.learningsPath).toBe(learningsPath);
    });

    it('AC2: an empty document writes no learnings.md, refuses a read of that path, and the adapter gets no learningsPath', async () => {
        const { config, board, worktrees, events, learningsPath } = await setUp();
        const learnings = new StaticLearningsStore('');

        let capturedInput: AgentRunInput | undefined;
        let decision: ScopeDecision | undefined;
        const dispatcher = buildDispatcher(
            config,
            board,
            worktrees,
            events,
            async input => {
                capturedInput = input;
                decision = await input.context.scope.checkRead(learningsPath);
            },
            learnings,
        );

        const result = await dispatcher.run('0001', 'testing');

        expect(result.passed).toBe(true);
        expect(existsSync(learningsPath)).toBe(false);
        expect(decision).toMatchObject({ allowed: false });
        expect(capturedInput?.learningsPath).toBeUndefined();
    });

    it('AC2: a dispatcher constructed with no LearningsStore at all behaves the same as an empty document', async () => {
        const { config, board, worktrees, events, learningsPath } = await setUp();

        let capturedInput: AgentRunInput | undefined;
        const dispatcher = buildDispatcher(
            config,
            board,
            worktrees,
            events,
            async input => {
                capturedInput = input;
            },
            undefined,
        );

        const result = await dispatcher.run('0001', 'testing');

        expect(result.passed).toBe(true);
        expect(existsSync(learningsPath)).toBe(false);
        expect(capturedInput?.learningsPath).toBeUndefined();
    });

    it('AC3: the learnings path is never made writable through the write tool, even though it is readable', async () => {
        const { config, board, worktrees, events, learningsPath } = await setUp();
        const learnings = new StaticLearningsStore('# Lessons\n\nDo not skip tests.\n');

        let writeDecision: ScopeDecision | undefined;
        const dispatcher = buildDispatcher(
            config,
            board,
            worktrees,
            events,
            async input => {
                writeDecision = await input.context.scope.check(learningsPath);
            },
            learnings,
        );

        const result = await dispatcher.run('0001', 'testing');

        expect(result.passed).toBe(true);
        expect(writeDecision).toMatchObject({ allowed: false });
    });
});
