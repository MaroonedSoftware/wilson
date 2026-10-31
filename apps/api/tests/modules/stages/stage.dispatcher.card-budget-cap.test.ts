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
import { StageVerifierMap } from '#modules/stages/stage.verifier.js';
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
    maxCardInputTokens: 1000
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
 * A card's ceiling used to be checked only before dispatch, so a run could overshoot it by a whole
 * run's budget. `withinCardBudget` has its own tests; this checks the dispatcher hands the adapter
 * the lowered cap, on the public path.
 */
describe('StageDispatcher.run caps a run at what remains of its card’s budget', () => {
    it('passes the adapter a stage whose input cap is the card’s remainder', async () => {
        const base = await mkdtemp(join(tmpdir(), 'stage-dispatcher-card-budget-'));
        const worktreeDir = join(base, 'worktree');
        await mkdir(join(worktreeDir, 'src'), { recursive: true });
        await exec('git', ['init'], { cwd: worktreeDir });
        await writeFile(join(worktreeDir, 'src', 'x.ts'), 'export const x = 1;\n', 'utf8');

        const config = new StaticBoardConfig(uniqueProject(), join(base, 'code'), join(base, 'worktrees'), join(base, 'run'));
        const events = { append: vi.fn(async () => {}), totalInputTokens: vi.fn(async () => 600) };
        const board: BoardRepository = new PostgresBoardRepository(config, db, events as unknown as EventLog);
        await board.create(card, 'initial');

        const worktrees = {
            resolveBranch: vi.fn(() => 'card/0001-do-the-thing'),
            hasWork: vi.fn(async () => false),
            create: vi.fn(async () => ({ path: worktreeDir, baseSha: 'deadbeef' })),
            commit: vi.fn(async () => 'committedsha'),
            reclaim: vi.fn(async () => {}),
            failedAttemptPatchPath: vi.fn((cardId: string) => join(base, 'run', 'cards', cardId, 'last-failed-attempt.patch')),
        };

        const run = vi.fn(async (_input: AgentRunInput): Promise<AgentRunOutput> => ({ result: undefined, truncated: true }));
        const agents = new StageAgentMap();
        agents.set('api', { run });
        const verifiers = new StageVerifierMap();
        verifiers.set('testing', { verify: async () => ({ passed: true, failures: [], changedPaths: [] }) });
        const resultSchemas = new StageResultSchemaMap();
        resultSchemas.set('testing', {} as never);

        const dispatcher = new StageDispatcher(
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

        await dispatcher.run('0001', 'testing');

        expect(run.mock.calls[0]?.[0].stage.maxInputTokens).toBe(400);
    });
});
