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
import { StageInterruptedError } from '#modules/agent/stage.interrupt.js';
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

/** A stage's end event names the engine account its usage was spent on, so spend can be summed by account. */
describe('StageDispatcher.run names the account a stage spent', () => {
    const setUp = async () => {
        const base = await mkdtemp(join(tmpdir(), 'stage-dispatcher-account-'));

        const worktreeDir = join(base, 'worktree');
        await mkdir(worktreeDir, { recursive: true });
        await exec('git', ['init'], { cwd: worktreeDir });
        await mkdir(join(worktreeDir, 'src'), { recursive: true });
        await writeFile(join(worktreeDir, 'src', 'x.ts'), 'export const x = 1;\n', 'utf8');

        const config = new StaticBoardConfig(uniqueProject(), join(base, 'code'), join(base, 'worktrees'), join(base, 'run'));
        const events = { append: vi.fn<EventLog['append']>(async () => {}) };
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
            uncommittedPaths: vi.fn(async () => []),
            uncommittedSnapshot: vi.fn(async () => ({})),
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

    const passing = async () => ({ passed: true, failures: [], changedPaths: [] });

    it('names the account on stage.passed', async () => {
        const { config, board, worktrees, events } = await setUp();
        const dispatcher = buildDispatcher(
            config,
            board,
            worktrees,
            events,
            async () => ({ result: { summary: 'did it', caveats: [] }, usage: { outputTokens: 7 }, account: 'pool-a', truncated: false }),
            passing,
        );

        await dispatcher.run('0001', 'testing');

        expect(events.append).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'stage.passed', payload: expect.objectContaining({ usage: { outputTokens: 7 }, account: 'pool-a' }) }),
        );
    });

    it('names the account on stage.interrupted', async () => {
        const { config, board, worktrees, events } = await setUp();
        const dispatcher = buildDispatcher(
            config,
            board,
            worktrees,
            events,
            async () => ({ usage: { outputTokens: 3 }, account: 'worker:my-mac', truncated: true, interrupted: { wallClockMs: 10, steps: 1 } }),
            passing,
        );

        await expect(dispatcher.run('0001', 'testing')).rejects.toBeInstanceOf(StageInterruptedError);

        expect(events.append).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'stage.interrupted',
                payload: expect.objectContaining({ usage: { outputTokens: 3 }, account: 'worker:my-mac' }),
            }),
        );
    });

    it('leaves the account out for an adapter that names none', async () => {
        const { config, board, worktrees, events } = await setUp();
        const dispatcher = buildDispatcher(
            config,
            board,
            worktrees,
            events,
            async () => ({ result: { summary: 'did it', caveats: [] }, usage: { outputTokens: 7 }, truncated: false }),
            passing,
        );

        await dispatcher.run('0001', 'testing');

        const passed = events.append.mock.calls.find(([evt]) => evt.type === 'stage.passed');
        expect(passed![0].payload).not.toHaveProperty('account');
    });
});
