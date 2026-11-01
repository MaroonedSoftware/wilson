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

// Both stages resume ('worktreeFrom: branch') so this exercises two dispatches on the same branch
// without needing real git resume/hasWork semantics — `worktrees` below is a full mock, same as
// `stage.dispatcher.collateral.test.ts` and `stage.dispatcher.approve-dispatch.test.ts`.
const stagesYaml = `
stages:
  - name: testing
    mode: agent
    model: claude-opus
    instructions: test it
    onPass: review
    onFail: testing
    worktreeFrom: branch
  - name: review
    mode: agent
    model: claude-opus
    instructions: review it
    onPass: dropped
    onFail: testing
    worktreeFrom: branch
`;

const seedCard: Card = {
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
 * Card 0095: `StageDispatcher` used to recompute `branchName(cardId, card.frontmatter.title)` on
 * every dispatch. A card renamed between two stages would then resume a branch that never existed,
 * or `create` would cut a fresh one and abandon every commit the card had made. The fix calls
 * `WorktreeManager.resolveBranch(head)` instead, and — the first time a worktree actually lands for a
 * card — records what it returned through `BoardRepository.write`, so every later dispatch prefers
 * that recorded value over whatever the (possibly since-renamed) title would derive.
 *
 * `WorktreeManager.resolveBranch`'s own resolution logic (recorded-branch-wins-over-title) is covered
 * directly in `worktree.manager.resolve-branch.test.ts`. What is under test here is what the
 * dispatcher itself does around that call: reading it off the live card, using its answer to cut the
 * worktree, and persisting it exactly once.
 */
describe("StageDispatcher records a card's branch on first dispatch and prefers it thereafter (card 0095)", () => {
    const setUp = async () => {
        const base = await mkdtemp(join(tmpdir(), 'stage-dispatcher-branch-'));

        const worktreeDir = join(base, 'worktree');
        await mkdir(join(worktreeDir, 'src'), { recursive: true });
        await exec('git', ['init'], { cwd: worktreeDir });
        await writeFile(join(worktreeDir, 'src', 'x.ts'), 'export const x = 1;\n', 'utf8');

        const config = new StaticBoardConfig(uniqueProject(), join(base, 'code'), join(base, 'worktrees'), join(base, 'run'));
        const events = { append: vi.fn(async () => {}) };
        const board: BoardRepository = new PostgresBoardRepository(config, db, events as unknown as EventLog);
        await board.create(seedCard, 'seed');

        const worktrees = {
            resolveBranch: vi.fn((card: Card) => card.frontmatter.branch ?? 'card/0001-do-the-thing'),
            hasWork: vi.fn(async () => true),
            create: vi.fn(async () => {
                throw new Error('MARKER: should not create — both stages here resume (worktreeFrom: branch)');
            }),
            resume: vi.fn(async () => ({ path: worktreeDir, baseSha: 'deadbeef' })),
            rebaseOntoHead: vi.fn(async () => ({ ok: true, baseSha: 'deadbeef' })),
            commit: vi.fn(async () => 'committedsha'),
            reclaim: vi.fn(async () => {}),
            // Card 0161: `run` now calls this unconditionally, once per board card, to grant read
            // access to every preserved patch — not just on a failure path.
            failedAttemptPatchPath: vi.fn((cardId: string) => `/tmp/run/cards/${cardId}/last-failed-attempt.patch`),
        };

        return { config, board, events, worktrees };
    };

    const buildDispatcher = (
        config: StaticBoardConfig,
        board: BoardRepository,
        events: { append: ReturnType<typeof vi.fn> },
        worktrees: unknown,
    ) => {
        const agents = new StageAgentMap();
        agents.set('api', {
            run: async (): Promise<AgentRunOutput> => ({ result: { summary: 'did the thing' }, usage: { inputTokens: 10 }, truncated: false }),
        });

        const verifiers = new StageVerifierMap();
        const verifier: StageVerifier = { verify: async () => ({ passed: true, failures: [], changedPaths: [] }) };
        verifiers.set('testing', verifier);
        verifiers.set('review', verifier);

        const resultSchemas = new StageResultSchemaMap();
        resultSchemas.set('testing', {} as never);
        resultSchemas.set('review', {} as never);

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

    it('records what resolveBranch returns after the first worktree lands, and writes nothing more for it on the next dispatch', async () => {
        const { config, board, events, worktrees } = await setUp();
        const dispatcher = buildDispatcher(config, board, events, worktrees);

        expect(await board.versions('0001', 10)).toHaveLength(1); // just the seed

        const first = await dispatcher.run('0001', 'testing');
        expect(first.passed).toBe(true);
        expect(first.transitionedTo).toBe('review');

        const afterFirst = await board.read('0001');
        expect(afterFirst.frontmatter.branch).toBe('card/0001-do-the-thing');
        expect(worktrees.resume).toHaveBeenCalledWith('0001', 'card/0001-do-the-thing');

        // Exactly two new versions from this one dispatch: the branch record, then the transition.
        expect(await board.versions('0001', 10)).toHaveLength(3);

        const second = await dispatcher.run('0001', 'review');
        expect(second.passed).toBe(true);
        expect(second.transitionedTo).toBe('dropped');

        // The live card the second dispatch resolved against already carried the branch recorded by
        // the first — proving the resolver was asked about the current, real state, not a copy from
        // before that write.
        expect(worktrees.resolveBranch).toHaveBeenCalledTimes(2);
        expect(worktrees.resolveBranch.mock.calls[1]![0]).toMatchObject({ frontmatter: { branch: 'card/0001-do-the-thing' } });
        expect(worktrees.resume).toHaveBeenLastCalledWith('0001', 'card/0001-do-the-thing');

        // Only the transition adds a version this time — the branch was already recorded, so nothing
        // records it again.
        expect(await board.versions('0001', 10)).toHaveLength(4);
        expect((await board.read('0001')).frontmatter.branch).toBe('card/0001-do-the-thing');
    });

    it('never overwrites a recorded branch, even if resolveBranch answers differently on a later dispatch', async () => {
        const { config, board, events, worktrees } = await setUp();
        let call = 0;
        worktrees.resolveBranch = vi.fn(() => {
            call += 1;
            return call === 1 ? 'card/0001-first-answer' : 'card/0001-should-never-be-persisted';
        });
        const dispatcher = buildDispatcher(config, board, events, worktrees);

        await dispatcher.run('0001', 'testing');
        expect((await board.read('0001')).frontmatter.branch).toBe('card/0001-first-answer');

        await dispatcher.run('0001', 'review');

        // The second dispatch's own worktree is cut on whatever resolveBranch just answered with...
        expect(worktrees.resume).toHaveBeenLastCalledWith('0001', 'card/0001-should-never-be-persisted');
        // ...but the recorded branch on the card itself — the fact every future dispatch and the
        // planning guard will read — never moves off what was first recorded.
        expect((await board.read('0001')).frontmatter.branch).toBe('card/0001-first-answer');
    });
});
