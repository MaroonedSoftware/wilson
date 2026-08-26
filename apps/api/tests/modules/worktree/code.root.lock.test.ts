import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeEach, describe, expect, it } from 'vitest';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { codeRootLock } from '#modules/worktree/code.root.lock.js';
import { WorktreeManager } from '#modules/worktree/worktree.manager.js';

const exec = promisify(execFile);

/**
 * `CARD_STAGE_CONCURRENCY` was 1 when `reclaim` was written, so `git worktree add`/`remove`/`prune`
 * against the shared `codeRoot` could not overlap. At 3 they can, and `prune` is repo-global rather
 * than scoped to the worktree being reclaimed — it deletes admin records for every worktree whose
 * directory it cannot see, including one another card is partway through registering.
 *
 * These assert the routing, not the race: that `create` and `reclaim` genuinely go through
 * `codeRootLock` rather than issuing their git commands straight away. Proving it by racing two real
 * `create` calls would be proving it by timing — fast enough git and the test passes whether or not
 * the lock is there. Holding the lock from the test instead makes the question deterministic: with
 * the lock held, nothing may reach the code repo at all.
 */
describe('WorktreeManager serializes the code repo through codeRootLock', () => {
    let codeRoot: string;
    let worktreeRoot: string;
    let manager: WorktreeManager;
    let logMessages: string[];

    beforeEach(async () => {
        const base = await mkdtemp(join(tmpdir(), 'code-root-lock-'));
        codeRoot = join(base, 'code');
        worktreeRoot = join(base, 'worktrees');
        await mkdir(join(codeRoot, 'src'), { recursive: true });

        await exec('git', ['init', '-q', '-b', 'main'], { cwd: codeRoot });
        await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: codeRoot });
        await exec('git', ['config', 'user.name', 'Test'], { cwd: codeRoot });
        await writeFile(join(codeRoot, 'src', 'index.ts'), 'export const x = 1;\n', 'utf8');
        await exec('git', ['add', '-A'], { cwd: codeRoot });
        await exec('git', ['commit', '-q', '-m', 'initial'], { cwd: codeRoot });

        logMessages = [];
        const logger = { info: (m: string) => logMessages.push(m), warn: () => {}, error: () => {}, debug: () => {} };
        const config = new StaticBoardConfig('test', join(base, 'board'), codeRoot, worktreeRoot, join(base, 'run'));
        manager = new WorktreeManager(config, logger as never);
    });

    it('does not touch the code repo while another holder has the lock, and says it is waiting', async () => {
        let releaseHolder!: () => void;
        const holderMayFinish = new Promise<void>(resolve => {
            releaseHolder = resolve;
        });
        let holding = false;

        const holder = codeRootLock.run(
            'test holder',
            () => {},
            async () => {
                holding = true;
                await holderMayFinish;
            },
        );

        // Poll rather than sleep a fixed amount: `holding` only flips true once `run` has actually
        // set its holder, so once this loop exits the `create` below is guaranteed to find the lock
        // taken rather than racing to find out.
        while (!holding) {
            await new Promise(resolve => setTimeout(resolve, 5));
        }

        const created = manager.create('0001', 'card/0001-thing');

        try {
            // Long enough that an unlocked `create` would have finished: `git worktree add` on a
            // one-commit repo is milliseconds. If the directory is still absent, `create` is queued.
            await new Promise(resolve => setTimeout(resolve, 200));
            expect(existsSync(join(worktreeRoot, '0001'))).toBe(false);
            expect(logMessages).toContain('0001 worktree create waiting for the code repo lock, held by test holder');
        } finally {
            // `codeRootLock` is a module singleton, so a failed assertion above must not leave it
            // held — every later test taking it would time out instead of reporting its own result.
            releaseHolder();
            await holder;
        }

        const worktree = await created;
        expect(existsSync(join(worktree.path, 'src', 'index.ts'))).toBe(true);
    });

    it('lets a queued reclaim through once the lock is free', async () => {
        const worktree = await manager.create('0002', 'card/0002-thing');
        expect(existsSync(worktree.path)).toBe(true);

        let releaseHolder!: () => void;
        const holderMayFinish = new Promise<void>(resolve => {
            releaseHolder = resolve;
        });
        let holding = false;

        const holder = codeRootLock.run(
            'test holder',
            () => {},
            async () => {
                holding = true;
                await holderMayFinish;
            },
        );
        while (!holding) {
            await new Promise(resolve => setTimeout(resolve, 5));
        }

        const reclaimed = manager.reclaim('0002');

        try {
            await new Promise(resolve => setTimeout(resolve, 200));
            expect(existsSync(worktree.path)).toBe(true);
        } finally {
            releaseHolder();
            await holder;
        }
        await reclaimed;

        expect(existsSync(worktree.path)).toBe(false);
    });

    /**
     * `Mutex` is deliberately not reentrant, and `create`/`resume` both reclaim while already
     * holding the lock. That is what `reclaimUnlocked` exists for; without it this test hangs rather
     * than fails, which is exactly the failure mode worth pinning down.
     */
    it('does not deadlock when create reclaims a worktree it already holds the lock for', async () => {
        await manager.create('0003', 'card/0003-thing');
        const again = await manager.create('0003', 'card/0003-thing');

        expect(existsSync(join(again.path, 'src', 'index.ts'))).toBe(true);
    });
});
