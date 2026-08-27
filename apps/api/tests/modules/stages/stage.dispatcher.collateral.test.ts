import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { StageDispatcher } from '#modules/stages/stage.dispatcher.js';
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
 * Card 0022: `StageDispatcher.run` computes `collateralPaths` from the worktree it just cut and
 * passes it to the `ScopeGuard` the agent runs against, then — once the run finishes — reads
 * `scope.collateralHits()` back off that same guard to record `scope.collateral` events and fold the
 * paths into the stage's own caveats.
 *
 * That whole chain only proves itself if something downstream actually exercises the guard it was
 * given. The stub agent adapter below does exactly that: it calls `context.scope.check(...)` itself,
 * the same call a real file-write tool makes, and hands the decisions back out through a closure so
 * the test can assert on the real `ScopeGuard` instance the dispatcher built — not a re-implementation
 * of it.
 */
describe('StageDispatcher.run wires collateralPaths into the ScopeGuard it hands the agent', () => {
    let boardRoot: string;
    let worktreeDir: string;
    let events: { append: ReturnType<typeof vi.fn> };

    const setUp = async (worktreeFiles: Record<string, string>) => {
        const base = await mkdtemp(join(tmpdir(), 'stage-dispatcher-collateral-'));
        boardRoot = join(base, 'board');
        await mkdir(join(boardRoot, 'cards'), { recursive: true });
        await mkdir(join(boardRoot, 'config'), { recursive: true });
        await writeFile(join(boardRoot, 'config', 'stages.yaml'), stagesYaml, 'utf8');

        worktreeDir = join(base, 'worktree');
        await mkdir(worktreeDir, { recursive: true });
        await exec('git', ['init'], { cwd: worktreeDir });
        for (const [relPath, content] of Object.entries(worktreeFiles)) {
            const absolute = join(worktreeDir, relPath);
            await mkdir(join(absolute, '..'), { recursive: true });
            await writeFile(absolute, content, 'utf8');
        }

        const config = new StaticBoardConfig(uniqueProject(), boardRoot, join(base, 'code'), join(base, 'worktrees'), join(base, 'run'));
        events = { append: vi.fn(async () => {}) };
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
        };

        return { config, board, worktrees };
    };

    /** Captures the decisions the stub adapter got back from the real ScopeGuard the dispatcher built. */
    const buildDispatcherWithProbingAdapter = (
        config: StaticBoardConfig,
        board: BoardRepository,
        worktrees: unknown,
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
            board,
            worktrees as unknown as WorktreeManager,
            agents,
            verifiers,
            resultSchemas,
            events as unknown as EventLog,
            silentLogger as never,
        );
    };

    it('allows a write to a file the scoped file imports, without it being in scope itself', async () => {
        const { config, board, worktrees } = await setUp({
            'src/x.ts': "import { y } from './y.js';\nexport const x = y;\n",
            'src/y.ts': 'export const y = 1;\n',
        });

        let collateralDecision: ScopeDecision | undefined;
        let unrelatedDecision: ScopeDecision | undefined;
        const dispatcher = buildDispatcherWithProbingAdapter(config, board, worktrees, async input => {
            // src/y.ts is not in "Files in scope" (only src/x.ts is) — it is only reachable because
            // src/x.ts, which is scoped, imports it.
            collateralDecision = await input.context.scope.check('src/y.ts');
            // A path with no structural relationship to anything scoped must still be refused —
            // proving the guard is not simply wide open.
            unrelatedDecision = await input.context.scope.check('src/unrelated.ts');
        });

        const result = await dispatcher.run('0001', 'testing');

        expect(collateralDecision).toMatchObject({ allowed: true, path: 'src/y.ts', via: 'collateral' });
        expect(unrelatedDecision).toMatchObject({ allowed: false });

        expect(result.passed).toBe(true);
        expect(result.transitionedTo).toBe('merged');

        expect(events.append).toHaveBeenCalledWith(
            expect.objectContaining({
                cardId: '0001',
                stage: 'testing',
                type: 'scope.collateral',
                payload: { path: 'src/y.ts' },
            }),
        );

        // The event log is not where a review looks for what to check — the reported result is, so
        // the widening also has to land in the stage's own caveats.
        const caveats = (result.result as { caveats?: string[] } | undefined)?.caveats ?? [];
        expect(caveats).toContainEqual(expect.stringContaining('src/y.ts'));
        expect(caveats).toContainEqual(expect.stringContaining('collateral'));
    });

    it('records no scope.collateral event and adds no caveat when the scoped file has no structural dependencies', async () => {
        const { config, board, worktrees } = await setUp({
            'src/x.ts': 'export const x = 1;\n',
        });

        const dispatcher = buildDispatcherWithProbingAdapter(config, board, worktrees, async () => {});

        const result = await dispatcher.run('0001', 'testing');

        expect(result.passed).toBe(true);
        expect(events.append).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'scope.collateral' }));

        const caveats = (result.result as { caveats?: string[] } | undefined)?.caveats ?? [];
        expect(caveats).toEqual([]);
    });
});
