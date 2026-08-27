import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RebaseConflictError, StageDispatcher } from '#modules/stages/stage.dispatcher.js';
import { PostgresBoardRepository } from '#modules/board/postgres.board.repository.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { StageAgentMap } from '#modules/agent/stage.agent.js';
import { StageVerifierMap } from '#modules/stages/stage.verifier.js';
import { StageResultSchemaMap } from '#modules/stages/stage.result.js';
import type { Card } from '#modules/board/card.js';
import type { EventLog } from '#modules/events/event.log.js';
import type { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import type { Kysely } from 'kysely';
import type { DB } from '#modules/data/db.js';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

// A real board in the test database, the same way stage.dispatcher.budget.test.ts sets one up: the
// point of this file is what `StageDispatcher.run` throws once the worktree layer reports a
// conflict, not a hand-rolled stand-in for the board.
let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

const baseCard: Card = {
    frontmatter: {
        id: '0001',
        title: 'do the thing',
        stage: 'testing',
        dependsOn: [],
        retries: {},
    },
    sections: {},
    body: '## Goal\n\nDo the thing.\n\n## Files in scope\n\n- src/x.ts\n',
};

const stagesYaml = `
stages:
  - name: testing
    mode: agent
    model: claude-opus
    instructions: test it
    onPass: merged
    onFail: testing
`;

/**
 * The branch is resumable — `hasWork` reports true, the way a card kicked back from review or
 * resumed mid-chain would — and its rebase onto the code repo's current HEAD conflicts. `create` and
 * `commit` are markers: a conflict must be discovered before either of them runs, or the worktree
 * layer is being touched on a path that is about to throw anyway.
 */
const conflictingWorktrees = (reason: string, targetSha: string) => ({
    resolveBranch: vi.fn(() => 'card/0001-do-the-thing'),
    hasWork: vi.fn(async () => true),
    resume: vi.fn(async () => ({ path: '/tmp/worktree-0001', baseSha: 'old-base-sha' })),
    rebaseOntoHead: vi.fn(async () => ({ ok: false as const, reason })),
    headSha: vi.fn(async () => targetSha),
    create: vi.fn(async () => {
        throw new Error('MARKER: worktree touched');
    }),
    commit: vi.fn(async () => {
        throw new Error('MARKER: worktree touched');
    }),
    reclaim: vi.fn(async () => {}),
});

const setUp = async (reason: string, targetSha: string) => {
    const base = await mkdtemp(join(tmpdir(), 'stage-dispatcher-rebase-conflict-'));
    const boardRoot = join(base, 'board');
    await mkdir(join(boardRoot, 'config'), { recursive: true });
    await writeFile(join(boardRoot, 'config', 'stages.yaml'), stagesYaml, 'utf8');
    const config = new StaticBoardConfig(uniqueProject(), boardRoot, join(base, 'code'), join(base, 'worktrees'), join(base, 'run'));
    const events = { append: vi.fn(async () => {}) };
    const board = new PostgresBoardRepository(config, db, events as unknown as EventLog);
    await board.create(baseCard, 'initial');
    const worktrees = conflictingWorktrees(reason, targetSha);

    const dispatcher = new StageDispatcher(
        config,
        board,
        worktrees as unknown as WorktreeManager,
        new StageAgentMap(),
        new StageVerifierMap(),
        new StageResultSchemaMap(),
        events as unknown as EventLog,
        silentLogger as never,
    );

    return { dispatcher, worktrees, events };
};

/**
 * Card 0103. `rebaseOntoHead` reporting `{ ok: false }` used to become a bare `Error`, indistinguishable
 * from any other stage failure once it reached `CardStageJob` — three retries, three worktrees, three
 * `pnpm install` runs, then poisoned. This pins down that `StageDispatcher.run` now throws the typed
 * `RebaseConflictError` instead, carrying exactly what `CardStageJob` needs to route it to a flag
 * rather than a retry: the branch, the commit it could not be replayed onto, and the conflict itself.
 */
describe('StageDispatcher.run on a rebase conflict (card 0103)', () => {
    const reason = 'CONFLICT (content): Merge conflict in src/index.ts';
    const targetSha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

    it('throws a RebaseConflictError, not a bare Error, naming the branch, target commit and conflict', async () => {
        const { dispatcher } = await setUp(reason, targetSha);

        const error = await dispatcher.run('0001', 'testing').then(
            () => {
                throw new Error('expected dispatcher.run to throw');
            },
            (err: unknown) => err,
        );

        expect(error).toBeInstanceOf(RebaseConflictError);
        const conflict = error as RebaseConflictError;
        expect(conflict.branch).toBe('card/0001-do-the-thing');
        expect(conflict.targetSha).toBe(targetSha);
        expect(conflict.detail).toBe(reason);
    });

    it('composes a message telling an operator exactly how to fix it', async () => {
        const { dispatcher } = await setUp(reason, targetSha);

        const error = (await dispatcher.run('0001', 'testing').catch((err: unknown) => err)) as RebaseConflictError;

        expect(error.message).toBe(`${reason} Rebase it onto ${targetSha.slice(0, 8)} by hand, then run \`wilson card start\`.`);
    });

    it('never creates, commits to, or reclaims a worktree once the rebase has conflicted', async () => {
        const { dispatcher, worktrees } = await setUp(reason, targetSha);

        await dispatcher.run('0001', 'testing').catch(() => {});

        expect(worktrees.create).not.toHaveBeenCalled();
        expect(worktrees.commit).not.toHaveBeenCalled();
        expect(worktrees.reclaim).not.toHaveBeenCalled();
    });

    it('never records worktree.created for a conflicted rebase', async () => {
        const { dispatcher, events } = await setUp(reason, targetSha);

        await dispatcher.run('0001', 'testing').catch(() => {});

        expect(events.append).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'worktree.created' }));
    });

    it("reads the target commit from the code repo's current HEAD, once, after the conflict is found", async () => {
        const { dispatcher, worktrees } = await setUp(reason, targetSha);

        await dispatcher.run('0001', 'testing').catch(() => {});

        expect(worktrees.headSha).toHaveBeenCalledTimes(1);
        expect(worktrees.rebaseOntoHead).toHaveBeenCalledTimes(1);
    });
});
