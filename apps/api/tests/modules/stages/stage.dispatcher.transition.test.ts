import { execFile } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
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
  - name: implementing
    mode: agent
    model: claude-opus
    instructions: build it
    onPass: testing
    onFail: implementing
  - name: testing
    mode: agent
    model: claude-opus
    instructions: test it
    onPass: merged
    onFail: testing
`;

const card: Card = {
    frontmatter: { id: '0001', title: 'do the thing', stage: 'testing', dependsOn: [], retries: {} },
    sections: { 'Files in scope': '- src/x.ts' },
    body: '## Goal\n\nDo the thing.\n\n## Files in scope\n\n- src/x.ts\n',
};

/** Everything `run` needs, with `duringRun` standing in for whatever happens while the agent works. */
const harness = async (duringRun: (board: BoardRepository) => Promise<void> = async () => {}) => {
    const base = await mkdtemp(join(tmpdir(), 'stage-dispatcher-transition-'));
    const worktreeDir = join(base, 'worktree');
    await mkdir(worktreeDir, { recursive: true });
    await exec('git', ['init'], { cwd: worktreeDir });

    const config = new StaticBoardConfig(uniqueProject(), join(base, 'code'), join(base, 'worktrees'), join(base, 'run'));
    const events = { append: vi.fn(async () => {}) };
    const board: BoardRepository = new PostgresBoardRepository(config, db, events as unknown as EventLog);
    await board.create(card, 'initial');

    const worktrees = {
        resolveBranch: vi.fn(() => 'card/0001-do-the-thing'),
        hasWork: vi.fn(async () => false),
        create: vi.fn(async () => ({ path: worktreeDir, baseSha: 'deadbeef' })),
        commit: vi.fn(async () => 'committedsha'),
        reclaim: vi.fn(async () => {}),
        failedAttemptPatchPath: vi.fn((cardId: string) => `/tmp/run/cards/${cardId}/last-failed-attempt.patch`),
    };

    const agents = new StageAgentMap();
    agents.set('api', {
        run: async (): Promise<AgentRunOutput> => {
            await duringRun(board);
            return { result: { summary: 'did the thing', caveats: [] }, usage: { inputTokens: 10 }, truncated: false };
        },
    });
    const verifiers = new StageVerifierMap();
    const verifier: StageVerifier = { verify: async () => ({ passed: true, failures: [], changedPaths: [] }) };
    verifiers.set('testing', verifier);
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
    return { board, events, dispatcher, worktrees };
};

const typesAppended = (events: { append: ReturnType<typeof vi.fn> }) => events.append.mock.calls.map(([event]) => (event as { type: string }).type);

describe('StageDispatcher.run writing a transition', () => {
    it('leaves a card a human moved during the run where they put it', async () => {
        const { board, events, dispatcher, worktrees } = await harness(board =>
            board.write('0001', 'moved by hand', current => ({ ...current, frontmatter: { ...current.frontmatter, stage: 'implementing' } })),
        );

        const outcome = await dispatcher.run('0001', 'testing');

        expect(outcome.passed).toBe(true);
        expect(outcome.transitionedTo).toBeUndefined();
        expect((await board.read('0001')).frontmatter.stage).toBe('implementing');
        expect(events.append).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'stage.stale', payload: { wantedStage: 'testing', actualStage: 'implementing' } }),
        );
        expect(typesAppended(events)).not.toContain('transition.written');
        expect(worktrees.reclaim).not.toHaveBeenCalled();
    });

    it('records a failed transition as transition.failed, not as the stage having failed', async () => {
        const { board, events, dispatcher } = await harness();
        vi.spyOn(board, 'writeWithEvent').mockRejectedValueOnce(new Error('connection lost'));

        await expect(dispatcher.run('0001', 'testing')).rejects.toThrow('connection lost');

        const types = typesAppended(events);
        expect(types).toContain('stage.passed');
        expect(types).toContain('transition.failed');
        expect(types).not.toContain('stage.failed');
    });
});
