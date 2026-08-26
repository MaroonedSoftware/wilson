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
 * Card 0089: naming the patch's path in the `stage.failed` event (or beside it) is what lets an
 * operator recovering a card find preserved work without knowing this card exists — "work saved that
 * nobody can find is work lost with extra steps". `worktrees.failedAttemptPatchPath` is a spy here
 * rather than the real `WorktreeManager`, so what is under test is specifically that
 * `StageDispatcher.run` reads that path and puts it on the event, on every route that fails a stage —
 * not the file it names, which `worktree.manager.test.ts` already covers directly.
 */
describe('StageDispatcher.run names the failed-attempt patch on a failing stage (card 0089)', () => {
    const setUp = async () => {
        const base = await mkdtemp(join(tmpdir(), 'stage-dispatcher-preserve-'));
        const boardRoot = join(base, 'board');
        await mkdir(join(boardRoot, 'cards'), { recursive: true });
        await mkdir(join(boardRoot, 'config'), { recursive: true });
        await writeFile(join(boardRoot, 'config', 'stages.yaml'), stagesYaml, 'utf8');

        const worktreeDir = join(base, 'worktree');
        await mkdir(worktreeDir, { recursive: true });
        await exec('git', ['init'], { cwd: worktreeDir });
        await mkdir(join(worktreeDir, 'src'), { recursive: true });
        await writeFile(join(worktreeDir, 'src', 'x.ts'), 'export const x = 1;\n', 'utf8');

        const config = new StaticBoardConfig(uniqueProject(), boardRoot, join(base, 'code'), join(base, 'worktrees'), join(base, 'run'));
        const events = { append: vi.fn(async () => {}) };
        const board: BoardRepository = new PostgresBoardRepository(config, db, events as unknown as EventLog);
        await board.create(card, 'initial');

        // The deterministic path a real `WorktreeManager` would compute — `<runRoot>/cards/<id>/
        // last-failed-attempt.patch` — asserted against below, so this stub matching the real
        // implementation is part of what makes the assertion meaningful, not incidental.
        const patchPath = join(base, 'run', 'cards', '0001', 'last-failed-attempt.patch');
        const worktrees = {
            branchName: vi.fn(() => 'card/0001-do-the-thing'),
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

        return { config, board, worktrees, events, patchPath };
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
            board,
            worktrees as unknown as WorktreeManager,
            agents,
            verifiers,
            resultSchemas,
            events as unknown as EventLog,
            silentLogger as never,
        );
    };

    it('names the patch path on stage.failed when the verifier rejects the run', async () => {
        const { config, board, worktrees, events, patchPath } = await setUp();
        const dispatcher = buildDispatcher(
            config,
            board,
            worktrees,
            events,
            async () => ({ result: { summary: 'did the thing', caveats: [] }, usage: { inputTokens: 10 }, truncated: false }),
            async () => ({ passed: false, failures: ['the tests do not cover the change'], changedPaths: [] }),
        );

        const result = await dispatcher.run('0001', 'testing');

        expect(result.passed).toBe(false);
        // Only a passing stage commits — a failed attempt's work never gets folded into the branch,
        // which is exactly why there is something uncommitted for `reclaim` to preserve later.
        expect(worktrees.commit).not.toHaveBeenCalled();
        expect(worktrees.failedAttemptPatchPath).toHaveBeenCalledWith('0001');
        expect(events.append).toHaveBeenCalledWith(
            expect.objectContaining({
                cardId: '0001',
                stage: 'testing',
                type: 'stage.failed',
                payload: expect.objectContaining({ patchPath }),
            }),
        );
    });

    it('names the same patch path on stage.failed when the stage throws outright', async () => {
        const { config, board, worktrees, events, patchPath } = await setUp();
        const dispatcher = buildDispatcher(
            config,
            board,
            worktrees,
            events,
            async () => {
                throw new Error('agent adapter exploded');
            },
            async () => ({ passed: true, failures: [], changedPaths: [] }),
        );

        await expect(dispatcher.run('0001', 'testing')).rejects.toThrow('agent adapter exploded');

        expect(worktrees.failedAttemptPatchPath).toHaveBeenCalledWith('0001');
        expect(events.append).toHaveBeenCalledWith(
            expect.objectContaining({
                cardId: '0001',
                stage: 'testing',
                type: 'stage.failed',
                payload: { error: 'agent adapter exploded', patchPath },
            }),
        );
    });

    it('does not name a patch path on stage.passed, since a clean commit leaves nothing to preserve', async () => {
        const { config, board, worktrees, events } = await setUp();
        const dispatcher = buildDispatcher(
            config,
            board,
            worktrees,
            events,
            async () => ({ result: { summary: 'did the thing', caveats: [] }, usage: { inputTokens: 10 }, truncated: false }),
            async () => ({ passed: true, failures: [], changedPaths: [] }),
        );

        const result = await dispatcher.run('0001', 'testing');

        expect(result.passed).toBe(true);
        expect(worktrees.failedAttemptPatchPath).not.toHaveBeenCalled();
        expect(events.append).toHaveBeenCalledWith(expect.objectContaining({ type: 'stage.passed' }));
        expect(events.append).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'stage.failed' }));
    });
});
