import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import type { LeaseService } from '#modules/lease/lease.service.js';

const exec = promisify(execFile);
const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/**
 * Exercises real git. The worktree lifecycle is the piece where a wrong assumption shows up as a
 * half-created tree rather than a type error, so it is worth the filesystem.
 */
describe('WorktreeManager', () => {
    let codeRoot: string;
    let manager: WorktreeManager;

    beforeEach(async () => {
        const base = await mkdtemp(join(tmpdir(), 'worktree-mgr-'));
        codeRoot = join(base, 'code');
        await mkdir(join(codeRoot, 'src'), { recursive: true });

        await exec('git', ['init', '-q', '-b', 'main'], { cwd: codeRoot });
        await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: codeRoot });
        await exec('git', ['config', 'user.name', 'Test'], { cwd: codeRoot });
        await writeFile(join(codeRoot, 'src', 'index.ts'), 'export const x = 1;\n', 'utf8');
        await exec('git', ['add', '-A'], { cwd: codeRoot });
        await exec('git', ['commit', '-q', '-m', 'initial'], { cwd: codeRoot });

        const config = new StaticBoardConfig('test', codeRoot, join(base, 'worktrees'), join(base, 'run'));
        manager = new WorktreeManager(config, silentLogger as never);
    });

    it('creates a worktree on its own branch at HEAD', async () => {
        const worktree = await manager.create('0001', 'card/0001-thing');

        expect(existsSync(join(worktree.path, 'src', 'index.ts'))).toBe(true);
        const { stdout } = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: worktree.path });
        expect(stdout.trim()).toBe('card/0001-thing');

        const head = await exec('git', ['rev-parse', 'HEAD'], { cwd: codeRoot });
        expect(worktree.baseSha).toBe(head.stdout.trim());
    });

    describe('cutting from a specific commit', () => {
        // The baseline check (card 0004) cuts a second worktree from the card's own base rather than
        // from HEAD, so that "pre-change" means what the card actually branched from — not whatever
        // has landed on main since.
        it('cuts from the given commit rather than HEAD', async () => {
            const base = (await exec('git', ['rev-parse', 'HEAD'], { cwd: codeRoot })).stdout.trim();
            await writeFile(join(codeRoot, 'src', 'later.ts'), 'export const later = 1;\n', 'utf8');
            await exec('git', ['add', '-A'], { cwd: codeRoot });
            await exec('git', ['commit', '-q', '-m', 'later'], { cwd: codeRoot });

            const worktree = await manager.create('0001-baseline', 'card/0001-baseline', base);

            expect(worktree.baseSha).toBe(base);
            // The file added after `base` must not be there, or the baseline is not the pre-change tree.
            expect(existsSync(join(worktree.path, 'src', 'later.ts'))).toBe(false);
        });

        it('still uses HEAD when no commit is given', async () => {
            const head = (await exec('git', ['rev-parse', 'HEAD'], { cwd: codeRoot })).stdout.trim();
            await expect(manager.create('0001', 'card/0001-thing')).resolves.toMatchObject({ baseSha: head });
        });

        it('can hold a baseline worktree and the card worktree at once', async () => {
            // They coexist during the baseline check, on different branches and different commits.
            const card = await manager.create('0001', 'card/0001-thing');
            const baseline = await manager.create('0001-baseline', 'card/0001-baseline', card.baseSha);
            expect(existsSync(card.path)).toBe(true);
            expect(existsSync(baseline.path)).toBe(true);
        });
    });

    it('reclaims a stale worktree instead of colliding with it', async () => {
        const first = await manager.create('0001', 'card/0001-thing');
        // A dead run leaves artifacts behind; the next attempt must not verify them.
        await writeFile(join(first.path, 'src', 'leftover.ts'), 'junk', 'utf8');

        const second = await manager.create('0001', 'card/0001-thing');
        expect(existsSync(join(second.path, 'src', 'leftover.ts'))).toBe(false);
    });

    it('reports modified files as changed', async () => {
        const worktree = await manager.create('0001', 'card/0001-thing');
        await writeFile(join(worktree.path, 'src', 'index.ts'), 'export const x = 2;\n', 'utf8');

        await expect(manager.changedPaths(worktree)).resolves.toEqual(['src/index.ts']);
    });

    it('reports untracked new files as changed', async () => {
        const worktree = await manager.create('0001', 'card/0001-thing');
        await writeFile(join(worktree.path, 'src', 'added.ts'), 'export const y = 1;\n', 'utf8');

        // Without this, a stage that creates a file and never stages it reads as an empty diff —
        // an exit condition satisfied by doing nothing visible.
        await expect(manager.changedPaths(worktree)).resolves.toEqual(['src/added.ts']);
    });

    it('reports deleted files as changed', async () => {
        const worktree = await manager.create('0001', 'card/0001-thing');
        await exec('git', ['rm', '-q', 'src/index.ts'], { cwd: worktree.path });

        await expect(manager.changedPaths(worktree)).resolves.toEqual(['src/index.ts']);
    });

    it('reports nothing changed on a fresh worktree', async () => {
        const worktree = await manager.create('0001', 'card/0001-thing');
        await expect(manager.changedPaths(worktree)).resolves.toEqual([]);
    });

    // Card 0024 extracted this from a direct `git diff --name-status <baseSha>` call inline in
    // `testing.verifier.ts`, so `worktree.baseSha` is dereferenced in this one file instead of two.
    // `TestingVerifier`'s own tests already exercise the behaviour indirectly through real stage
    // runs; these cover the method itself, the same way `changedPaths` above is covered directly.
    describe('addedPaths', () => {
        it('reports a new, committed file as added', async () => {
            const worktree = await manager.create('0001', 'card/0001-thing');
            await writeFile(join(worktree.path, 'src', 'added.ts'), 'export const y = 1;\n', 'utf8');
            await exec('git', ['add', '-A'], { cwd: worktree.path });
            await exec('git', ['commit', '-q', '-m', 'add a file'], { cwd: worktree.path });

            await expect(manager.addedPaths(worktree)).resolves.toEqual(['src/added.ts']);
        });

        it('reports an untracked new file as added', async () => {
            const worktree = await manager.create('0001', 'card/0001-thing');
            await writeFile(join(worktree.path, 'src', 'added.ts'), 'export const y = 1;\n', 'utf8');

            await expect(manager.addedPaths(worktree)).resolves.toEqual(['src/added.ts']);
        });

        it('excludes a pre-existing file that was only modified', async () => {
            const worktree = await manager.create('0001', 'card/0001-thing');
            await writeFile(join(worktree.path, 'src', 'index.ts'), 'export const x = 2;\n', 'utf8');
            await writeFile(join(worktree.path, 'src', 'added.ts'), 'export const y = 1;\n', 'utf8');
            await exec('git', ['add', '-A'], { cwd: worktree.path });
            await exec('git', ['commit', '-q', '-m', 'modify and add'], { cwd: worktree.path });

            await expect(manager.addedPaths(worktree)).resolves.toEqual(['src/added.ts']);
        });

        it('excludes a deleted file', async () => {
            const worktree = await manager.create('0001', 'card/0001-thing');
            await exec('git', ['rm', '-q', 'src/index.ts'], { cwd: worktree.path });
            await exec('git', ['commit', '-q', '-m', 'remove a file'], { cwd: worktree.path });

            await expect(manager.addedPaths(worktree)).resolves.toEqual([]);
        });

        it('reports nothing added on a fresh worktree', async () => {
            const worktree = await manager.create('0001', 'card/0001-thing');
            await expect(manager.addedPaths(worktree)).resolves.toEqual([]);
        });
    });

    it('removes the directory and prunes git bookkeeping on reclaim', async () => {
        const worktree = await manager.create('0001', 'card/0001-thing');
        await manager.reclaim('0001');

        expect(existsSync(worktree.path)).toBe(false);
        // git's own bookkeeping must be pruned too, or the next `worktree add` refuses the path.
        const { stdout } = await exec('git', ['worktree', 'list'], { cwd: codeRoot });
        expect(stdout).not.toContain('0001');
    });

    describe('commit', () => {
        /**
         * A pre-commit hook in the project's own `.git/hooks` — shared by every worktree of a repo,
         * `core.hooksPath` aside — so writing it under `codeRoot` is enough to make it fire on a
         * commit made from a linked worktree too.
         */
        const installPreCommitHook = async (script: string): Promise<string> => {
            const hooksDir = join(codeRoot, '.git', 'hooks');
            await mkdir(hooksDir, { recursive: true });
            const hookPath = join(hooksDir, 'pre-commit');
            await writeFile(hookPath, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
            return hookPath;
        };

        // A stage's work only ever exists as uncommitted changes in a worktree. The next stage's
        // resume reclaims the directory first, so without committing, the hand-off deletes it.
        it('commits everything the stage produced, tracked and untracked alike', async () => {
            const worktree = await manager.create('0001', 'card/0001-thing');
            await writeFile(join(worktree.path, 'src', 'index.ts'), 'export const x = 2;\n', 'utf8');
            await writeFile(join(worktree.path, 'src', 'added.ts'), 'export const y = 1;\n', 'utf8');

            const sha = await manager.commit(worktree, '0001: implementing');

            expect(sha).toBeDefined();
            const { stdout } = await exec('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: worktree.path });
            expect(stdout.split('\n').filter(Boolean).sort()).toEqual(['src/added.ts', 'src/index.ts']);
        });

        it('survives the round trip through resume', async () => {
            const worktree = await manager.create('0001', 'card/0001-thing');
            await writeFile(join(worktree.path, 'src', 'feature.ts'), 'export const feature = 1;\n', 'utf8');
            await manager.commit(worktree, '0001: implementing');

            const resumed = await manager.resume('0001', 'card/0001-thing');
            expect(existsSync(join(resumed.path, 'src', 'feature.ts'))).toBe(true);
        });

        it('returns undefined when the stage changed nothing, rather than making an empty commit', async () => {
            const worktree = await manager.create('0001', 'card/0001-thing');
            await expect(manager.commit(worktree, '0001: implementing')).resolves.toBeUndefined();
        });

        // Card 0071: without `--no-verify`, a failing pre-commit hook makes `git commit` throw in a
        // shape `isPermanentFailure` never matches, so the stage retries and dead-letters redoing
        // passing work every attempt — even though the stage's own verifier already passed it.
        it('succeeds through a pre-commit hook that would reject the commit, and never runs the hook at all', async () => {
            const markerPath = join(codeRoot, 'hook-ran');
            await installPreCommitHook(`touch "${markerPath}"\nexit 1`);

            const worktree = await manager.create('0001', 'card/0001-thing');
            await writeFile(join(worktree.path, 'src', 'index.ts'), 'export const x = 2;\n', 'utf8');

            const sha = await manager.commit(worktree, '0001: implementing');

            expect(sha).toBeDefined();
            // `--no-verify` skips the hook outright — it never runs, not merely "runs but is
            // overridden" — so the marker it would have written is absent.
            expect(existsSync(markerPath)).toBe(false);
        });

        // Card 0071: a rewriting hook (lint-staged and its kin) changes the tree after the verifier
        // already checked it, breaking "what a stage wrote is exactly what is uncommitted at
        // verification time" — the invariant scope enforcement stands on. `--no-verify` keeps the
        // committed tree byte-identical to what the stage actually staged.
        it('commits exactly what was staged, unmodified by a hook that would rewrite it', async () => {
            await installPreCommitHook(`echo "// formatted" >> src/index.ts\ngit add -A\nexit 0`);

            const worktree = await manager.create('0001', 'card/0001-thing');
            const written = 'export const x = 2;\n';
            await writeFile(join(worktree.path, 'src', 'index.ts'), written, 'utf8');

            await manager.commit(worktree, '0001: implementing');

            const { stdout } = await exec('git', ['show', 'HEAD:src/index.ts'], { cwd: worktree.path });
            expect(stdout).toBe(written);
        });
    });

    describe('hasWork', () => {
        // Decides whether a stage resumes or starts fresh. A card kicked back from review carries
        // findings citing file:line on its own branch; rebuilding from base would discard the work
        // those findings are about.
        it('is false for a branch that does not exist', async () => {
            await expect(manager.hasWork('card/9999-nothing')).resolves.toBe(false);
        });

        it('is false for a branch cut but never committed to', async () => {
            await manager.create('0001', 'card/0001-thing');
            await expect(manager.hasWork('card/0001-thing')).resolves.toBe(false);
        });

        it('is true once a stage has committed to it', async () => {
            const worktree = await manager.create('0001', 'card/0001-thing');
            await writeFile(join(worktree.path, 'src', 'feature.ts'), 'export const feature = 1;\n', 'utf8');
            await manager.commit(worktree, '0001: implementing');

            await expect(manager.hasWork('card/0001-thing')).resolves.toBe(true);
        });
    });

    describe('uncommittedPaths', () => {
        // `changedPaths` measures from the fork point, so on a resumed branch it describes the whole
        // card and is never empty. A read-only stage has to be judged on what *it* wrote.
        it('is empty on a clean resumed branch, where changedPaths is not', async () => {
            const first = await manager.create('0001', 'card/0001-thing');
            await writeFile(join(first.path, 'src', 'feature.ts'), 'export const feature = 1;\n', 'utf8');
            await manager.commit(first, '0001: implementing');

            const resumed = await manager.resume('0001', 'card/0001-thing');

            await expect(manager.uncommittedPaths(resumed)).resolves.toEqual([]);
            await expect(manager.changedPaths(resumed)).resolves.toEqual(['src/feature.ts']);
        });

        it('reports a file the stage modified', async () => {
            const worktree = await manager.create('0001', 'card/0001-thing');
            await writeFile(join(worktree.path, 'src', 'index.ts'), 'export const x = 2;\n', 'utf8');
            await expect(manager.uncommittedPaths(worktree)).resolves.toEqual(['src/index.ts']);
        });

        it('reports a file the stage created', async () => {
            const worktree = await manager.create('0001', 'card/0001-thing');
            await writeFile(join(worktree.path, 'src', 'new.ts'), 'export const n = 1;\n', 'utf8');
            await expect(manager.uncommittedPaths(worktree)).resolves.toEqual(['src/new.ts']);
        });

        // Card 0191. The tests above write into `src/`, which the fixture repo already tracks, so
        // every one of them passed while this case was broken: `git status --porcelain` on its own
        // collapses an *untracked* directory into a single entry, and this returned
        // `src/modules/` rather than the two files. The implementing verifier matches each of
        // these paths against the plan's file globs, which no directory can satisfy, so a card
        // creating a new directory failed however its plan was written — card 0186 lost three
        // attempts to it.
        it('lists the files under a directory the stage created, not the directory itself', async () => {
            const worktree = await manager.create('0001', 'card/0001-thing');
            await mkdir(join(worktree.path, 'src', 'modules', 'context'), { recursive: true });
            await writeFile(join(worktree.path, 'src', 'modules', 'context', 'a.ts'), 'export const a = 1;\n', 'utf8');
            await writeFile(join(worktree.path, 'src', 'modules', 'context', 'b.ts'), 'export const b = 2;\n', 'utf8');

            await expect(manager.uncommittedPaths(worktree)).resolves.toEqual(['src/modules/context/a.ts', 'src/modules/context/b.ts']);
        });
    });

    describe('resume', () => {
        // Every stage after the first works on the tree the previous stage produced. `create` uses
        // -B, which resets the branch — running the testing stage through it would delete the very
        // work it was asked to write tests for.
        it('keeps commits an earlier stage made on the branch', async () => {
            const first = await manager.create('0001', 'card/0001-thing');
            await writeFile(join(first.path, 'src', 'feature.ts'), 'export const feature = 1;\n', 'utf8');
            await manager.commit(first, 'implementing');

            const resumed = await manager.resume('0001', 'card/0001-thing');

            expect(existsSync(join(resumed.path, 'src', 'feature.ts'))).toBe(true);
        });

        it('reports the fork point, so the diff covers every stage of the card', async () => {
            const first = await manager.create('0001', 'card/0001-thing');
            const forkPoint = first.baseSha;
            await writeFile(join(first.path, 'src', 'feature.ts'), 'export const feature = 1;\n', 'utf8');
            await exec('git', ['add', '-A'], { cwd: first.path });
            await exec('git', ['commit', '-q', '-m', 'implementing'], { cwd: first.path });

            const resumed = await manager.resume('0001', 'card/0001-thing');

            // Not the branch tip: the testing stage must still see what implementing changed.
            expect(resumed.baseSha).toBe(forkPoint);
            await expect(manager.changedPaths(resumed)).resolves.toEqual(['src/feature.ts']);
        });

        it('refuses when the branch has no work, naming the likely cause', async () => {
            await expect(manager.resume('0009', 'card/0009-never-ran')).rejects.toThrow(/has an earlier stage run/);
        });
    });

    it('is safe to reclaim something that was never created', async () => {
        await expect(manager.reclaim('9999')).resolves.toBeUndefined();
    });

    /**
     * Card 0165: a lease cannot outlive the worktree it was taken for, so `reclaimUnlocked` releases
     * the card's leases before deleting the tree. `manager` (the shared fixture above) is built with
     * no third constructor argument at all, and every other test in this file already reclaims
     * through it without incident — proof by the whole rest of the suite that leaving `leases` out
     * is still safe, exactly as the constructor's own doc comment claims. These tests build a second
     * manager, against the same underlying git repo, that does take one.
     */
    describe('releasing leases on reclaim', () => {
        const buildManagerWithLeases = async (leases: LeaseService): Promise<WorktreeManager> => {
            const base = await mkdtemp(join(tmpdir(), 'worktree-mgr-leases-'));
            const config = new StaticBoardConfig('leases-test-project', codeRoot, join(base, 'worktrees'), join(base, 'run'));
            return new WorktreeManager(config, silentLogger as never, leases);
        };

        it('releases the leases held by the card whose worktree is reclaimed', async () => {
            const fakeLeases = { releaseAll: vi.fn(async () => undefined) } as unknown as LeaseService;
            const managerWithLeases = await buildManagerWithLeases(fakeLeases);
            await managerWithLeases.create('0001', 'card/0001-thing');

            await managerWithLeases.reclaim('0001');

            expect(fakeLeases.releaseAll).toHaveBeenCalledWith('leases-test-project', '0001');
        });

        it('does not let a failure to release leases stop the reclaim itself', async () => {
            const fakeLeases = {
                releaseAll: vi.fn(async () => {
                    throw new Error('boom');
                }),
            } as unknown as LeaseService;
            const managerWithLeases = await buildManagerWithLeases(fakeLeases);
            const worktree = await managerWithLeases.create('0001', 'card/0001-thing');

            await expect(managerWithLeases.reclaim('0001')).resolves.toBeUndefined();

            expect(existsSync(worktree.path)).toBe(false);
            expect(fakeLeases.releaseAll).toHaveBeenCalledWith('leases-test-project', '0001');
        });
    });

    /**
     * Card 0089: three of card 0078's testing-stage attempts each wrote real tests, and each
     * attempt's work was destroyed outright — not merely left uncommitted — the moment the next
     * attempt's `create`/`resume` reclaimed the worktree, since reclaiming had no way to keep
     * anything. `reclaim` now saves whatever is dirty as a patch before it deletes the tree.
     */
    describe('preserving a failed attempt before reclaim deletes it', () => {
        it('saves uncommitted tracked and untracked changes as a patch before deleting the tree', async () => {
            const worktree = await manager.create('0001', 'card/0001-thing');
            await writeFile(join(worktree.path, 'src', 'index.ts'), 'export const x = 2;\n', 'utf8');
            await writeFile(join(worktree.path, 'src', 'new.ts'), 'export const n = 1;\n', 'utf8');

            await manager.reclaim('0001');

            const patchPath = manager.failedAttemptPatchPath('0001');
            expect(existsSync(patchPath)).toBe(true);
            const patch = await readFile(patchPath, 'utf8');
            expect(patch).toContain('src/index.ts');
            // Untracked files never show up in a diff against HEAD — `git add -A` first is what makes
            // them appear here at all. This is exactly the gap that lost card 0078's new test files.
            expect(patch).toContain('src/new.ts');
            expect(existsSync(worktree.path)).toBe(false);
        });

        it('produces a patch that git apply can use to actually recover the lost work', async () => {
            const worktree = await manager.create('0001', 'card/0001-thing');
            await writeFile(join(worktree.path, 'src', 'index.ts'), 'export const x = 2;\n', 'utf8');
            await writeFile(join(worktree.path, 'src', 'new.ts'), 'export const n = 1;\n', 'utf8');
            const baseSha = worktree.baseSha;

            await manager.reclaim('0001');

            const recovery = await mkdtemp(join(tmpdir(), 'worktree-mgr-recovery-'));
            await exec('git', ['clone', '-q', codeRoot, recovery]);
            await exec('git', ['checkout', '-q', baseSha], { cwd: recovery });
            await exec('git', ['apply', manager.failedAttemptPatchPath('0001')], { cwd: recovery });

            expect(await readFile(join(recovery, 'src', 'index.ts'), 'utf8')).toBe('export const x = 2;\n');
            expect(await readFile(join(recovery, 'src', 'new.ts'), 'utf8')).toBe('export const n = 1;\n');
        });

        it('writes no patch for a clean tree, so a passing stage leaves nothing behind', async () => {
            await manager.create('0001', 'card/0001-thing');
            await manager.reclaim('0001');

            expect(existsSync(manager.failedAttemptPatchPath('0001'))).toBe(false);
        });

        it('writes no patch when reclaiming a card that was never created', async () => {
            await manager.reclaim('9999');
            expect(existsSync(manager.failedAttemptPatchPath('9999'))).toBe(false);
        });

        it('overwrites the patch on a second failure, leaving exactly one per card', async () => {
            const first = await manager.create('0001', 'card/0001-thing');
            await writeFile(join(first.path, 'src', 'first-attempt.ts'), 'export const a = 1;\n', 'utf8');
            await manager.reclaim('0001');

            const second = await manager.create('0001', 'card/0001-thing');
            await writeFile(join(second.path, 'src', 'second-attempt.ts'), 'export const b = 2;\n', 'utf8');
            await manager.reclaim('0001');

            const patch = await readFile(manager.failedAttemptPatchPath('0001'), 'utf8');
            expect(patch).toContain('second-attempt.ts');
            expect(patch).not.toContain('first-attempt.ts');
        });

        it('goes through reclaim on create too, since that is what deletes the tree between attempts', async () => {
            const first = await manager.create('0001', 'card/0001-thing');
            await writeFile(join(first.path, 'src', 'lost.ts'), 'export const lost = 1;\n', 'utf8');

            // The next attempt's `create` reclaims the stale worktree exactly as it does today (see
            // "reclaims a stale worktree instead of colliding with it" above) — the point here is that
            // doing so no longer just discards what was there.
            await manager.create('0001', 'card/0001-thing');

            const patch = await readFile(manager.failedAttemptPatchPath('0001'), 'utf8');
            expect(patch).toContain('src/lost.ts');
        });

        it('does not let a failure to write the patch stop the reclaim itself', async () => {
            const worktree = await manager.create('0001', 'card/0001-thing');
            await writeFile(join(worktree.path, 'src', 'index.ts'), 'export const x = 2;\n', 'utf8');
            // Breaks every git command run inside the worktree itself, without touching the main
            // repo's own worktree bookkeeping — `preserveUncommitted`'s own error handling is what's
            // under test here, not `reclaimUnlocked`'s pre-existing tolerance of `git worktree remove`
            // failing.
            await rm(join(worktree.path, '.git'));

            await expect(manager.reclaim('0001')).resolves.toBeUndefined();
            expect(existsSync(worktree.path)).toBe(false);
        });

        it('does not change what a resumed stage starts from — only what was committed, never the patch', async () => {
            // The rule this card sits under, asserted rather than assumed: preserving a patch must
            // not let the next attempt inherit the previous one's uncommitted tree.
            const first = await manager.create('0001', 'card/0001-thing');
            await writeFile(join(first.path, 'src', 'feature.ts'), 'export const feature = 1;\n', 'utf8');
            await manager.commit(first, '0001: implementing');
            // A second, failed attempt on the same branch, never committed.
            await writeFile(join(first.path, 'src', 'scratch.ts'), 'export const scratch = 1;\n', 'utf8');

            const resumed = await manager.resume('0001', 'card/0001-thing');

            expect(existsSync(join(resumed.path, 'src', 'feature.ts'))).toBe(true);
            expect(existsSync(join(resumed.path, 'src', 'scratch.ts'))).toBe(false);
            // But it was not simply thrown away — it is sitting in the patch.
            const patch = await readFile(manager.failedAttemptPatchPath('0001'), 'utf8');
            expect(patch).toContain('src/scratch.ts');
        });
    });

    describe('branchName', () => {
        it('slugifies the title', () => {
            expect(manager.branchName('0042', 'Port allocator')).toBe('card/0042-port-allocator');
        });

        it('strips punctuation rather than emitting an invalid ref', () => {
            expect(manager.branchName('0042', 'Fix: the "thing" (again)!')).toBe('card/0042-fix-the-thing-again');
        });

        it('falls back to the bare id when the title slugifies to nothing', () => {
            expect(manager.branchName('0042', '!!!')).toBe('card/0042');
        });
    });

    describe('rebaseOntoHead', () => {
        // Card 0014 sat six commits behind while its own plan described an adapter that had landed
        // on main meanwhile. The stage could not see it and the review, searching the tree, quite
        // correctly reported it missing — nothing could tell "does not exist" from "not here".
        it('replays the branch onto a moved HEAD and reports the new base', async () => {
            const worktree = await manager.create('0001', 'card/0001-thing');
            await writeFile(join(worktree.path, 'src', 'card.ts'), 'export const card = 1;\n', 'utf8');
            await manager.commit(worktree, '0001: implementing');

            // main moves on with an unrelated file.
            await writeFile(join(codeRoot, 'src', 'landed.ts'), 'export const landed = 1;\n', 'utf8');
            await exec('git', ['add', '-A'], { cwd: codeRoot });
            await exec('git', ['commit', '-q', '-m', 'landed on main'], { cwd: codeRoot });
            const head = (await exec('git', ['rev-parse', 'HEAD'], { cwd: codeRoot })).stdout.trim();

            const resumed = await manager.resume('0001', 'card/0001-thing');
            const result = await manager.rebaseOntoHead(resumed);

            expect(result).toMatchObject({ ok: true, baseSha: head });
            // The card keeps its own work and now sees what landed on main.
            expect(existsSync(join(resumed.path, 'src', 'card.ts'))).toBe(true);
            expect(existsSync(join(resumed.path, 'src', 'landed.ts'))).toBe(true);
        });

        it('is a no-op when the branch is already current', async () => {
            const worktree = await manager.create('0001', 'card/0001-thing');
            await expect(manager.rebaseOntoHead(worktree)).resolves.toMatchObject({ ok: true, baseSha: worktree.baseSha });
        });

        it('aborts a conflicting rebase rather than leaving the worktree half-replayed', async () => {
            const worktree = await manager.create('0001', 'card/0001-thing');
            await writeFile(join(worktree.path, 'src', 'index.ts'), 'export const x = 100;\n', 'utf8');
            await manager.commit(worktree, '0001: implementing');

            // main edits the same line differently.
            await writeFile(join(codeRoot, 'src', 'index.ts'), 'export const x = 999;\n', 'utf8');
            await exec('git', ['add', '-A'], { cwd: codeRoot });
            await exec('git', ['commit', '-q', '-m', 'conflicting change'], { cwd: codeRoot });

            const resumed = await manager.resume('0001', 'card/0001-thing');
            const result = await manager.rebaseOntoHead(resumed);

            expect(result).toMatchObject({ ok: false });
            // No rebase left in progress for the next stage to trip over.
            const { stdout } = await exec('git', ['status', '--porcelain=v2', '--branch'], { cwd: resumed.path });
            expect(stdout).not.toContain('rebase');
        });
    });

    /**
     * Card 0143: the merge computed without a checkout. `computeMerge` reads `codeRoot`'s own HEAD
     * as `main` — these tests exercise that reading against a real repo, the same idiom every other
     * `describe` block in this file uses, rather than mocking `git`.
     */
    describe('computeMerge', () => {
        it('computes the tree and both parent shas for a clean merge, leaving codeRoot untouched', async () => {
            const worktree = await manager.create('0001', 'card/0001-thing');
            await writeFile(join(worktree.path, 'src', 'card.ts'), 'export const card = 1;\n', 'utf8');
            await manager.commit(worktree, '0001: implementing');
            const branchSha = (await exec('git', ['rev-parse', 'card/0001-thing'], { cwd: worktree.path })).stdout.trim();
            const mainSha = (await exec('git', ['rev-parse', 'HEAD'], { cwd: codeRoot })).stdout.trim();

            const result = await manager.computeMerge('card/0001-thing', 'main');

            expect(result).toMatchObject({ ok: true, targetSha: mainSha, branchSha });
            if (!result.ok) throw new Error('expected a clean merge');
            const cardFile = await exec('git', ['show', `${result.treeSha}:src/card.ts`], { cwd: codeRoot });
            expect(cardFile.stdout).toBe('export const card = 1;\n');

            // codeRoot is checked out at `main` throughout — computing the merge must not move it or
            // dirty its working tree, the constraint this whole no-checkout approach exists to honour.
            const branch = (await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: codeRoot })).stdout.trim();
            expect(branch).toBe('main');
            const status = (await exec('git', ['status', '--porcelain'], { cwd: codeRoot })).stdout;
            expect(status.trim()).toBe('');
        });

        it('reports the conflicting paths, and still leaves codeRoot untouched, when the branch conflicts with main', async () => {
            const worktree = await manager.create('0001', 'card/0001-thing');
            await writeFile(join(worktree.path, 'src', 'index.ts'), 'export const x = 100;\n', 'utf8');
            await manager.commit(worktree, '0001: implementing');

            // main edits the same line differently after the branch was cut.
            await writeFile(join(codeRoot, 'src', 'index.ts'), 'export const x = 999;\n', 'utf8');
            await exec('git', ['add', '-A'], { cwd: codeRoot });
            await exec('git', ['commit', '-q', '-m', 'conflicting change on main'], { cwd: codeRoot });

            const result = await manager.computeMerge('card/0001-thing', 'main');

            expect(result.ok).toBe(false);
            if (result.ok) throw new Error('expected a conflict');
            expect(result.conflicts).toEqual(['src/index.ts']);

            const status = (await exec('git', ['status', '--porcelain'], { cwd: codeRoot })).stdout;
            expect(status.trim()).toBe('');
        });

        it('does not disturb uncommitted changes already sitting in codeRoot', async () => {
            const worktree = await manager.create('0001', 'card/0001-thing');
            await writeFile(join(worktree.path, 'src', 'card.ts'), 'export const card = 1;\n', 'utf8');
            await manager.commit(worktree, '0001: implementing');

            // An operator's own in-progress edit, sitting uncommitted in codeRoot.
            await writeFile(join(codeRoot, 'src', 'operator-scratch.ts'), 'export const scratch = 1;\n', 'utf8');

            await manager.computeMerge('card/0001-thing', 'main');

            expect(await readFile(join(codeRoot, 'src', 'operator-scratch.ts'), 'utf8')).toBe('export const scratch = 1;\n');
            const status = (await exec('git', ['status', '--porcelain'], { cwd: codeRoot })).stdout;
            expect(status.trim()).toBe('?? src/operator-scratch.ts');
        });
    });

    describe('commitMerge', () => {
        it('creates a commit with both shas as parents, unreferenced by any branch until landMerge', async () => {
            const worktree = await manager.create('0001', 'card/0001-thing');
            await writeFile(join(worktree.path, 'src', 'card.ts'), 'export const card = 1;\n', 'utf8');
            await manager.commit(worktree, '0001: implementing');
            const computed = await manager.computeMerge('card/0001-thing', 'main');
            if (!computed.ok) throw new Error('expected a clean merge');

            const mergeSha = await manager.commitMerge(computed.targetSha, computed.branchSha, computed.treeSha, 'Merge card 0001: thing');

            const parents = (await exec('git', ['show', '-s', '--format=%P', mergeSha], { cwd: codeRoot })).stdout.trim().split(' ');
            expect(parents).toEqual([computed.targetSha, computed.branchSha]);
            const message = (await exec('git', ['show', '-s', '--format=%s', mergeSha], { cwd: codeRoot })).stdout.trim();
            expect(message).toBe('Merge card 0001: thing');

            // Committing the object does not move main — landMerge is the only thing that does.
            const head = (await exec('git', ['rev-parse', 'HEAD'], { cwd: codeRoot })).stdout.trim();
            expect(head).toBe(computed.targetSha);
            expect(head).not.toBe(mergeSha);
        });
    });

    describe('landMerge', () => {
        it('moves main onto the merge commit, confirms the ref actually moved, and reconciles codeRoot to match', async () => {
            const worktree = await manager.create('0001', 'card/0001-thing');
            await writeFile(join(worktree.path, 'src', 'card.ts'), 'export const card = 1;\n', 'utf8');
            await manager.commit(worktree, '0001: implementing');
            const computed = await manager.computeMerge('card/0001-thing', 'main');
            if (!computed.ok) throw new Error('expected a clean merge');
            const mergeSha = await manager.commitMerge(computed.targetSha, computed.branchSha, computed.treeSha, 'Merge card 0001: thing');

            const result = await manager.landMerge(computed.targetSha, mergeSha, 'main');

            expect(result).toEqual({ ok: true });
            const head = (await exec('git', ['rev-parse', 'refs/heads/main'], { cwd: codeRoot })).stdout.trim();
            expect(head).toBe(mergeSha);
            const cardFile = await exec('git', ['show', 'refs/heads/main:src/card.ts'], { cwd: codeRoot });
            expect(cardFile.stdout).toBe('export const card = 1;\n');
            // Moving the ref is not the whole job (card 0143's Constraints): codeRoot's own working
            // tree and index must be brought up to the new `main` too, or `git status` would report
            // the merged file as a staged deletion even though `main` itself moved correctly.
            expect(await readFile(join(codeRoot, 'src', 'card.ts'), 'utf8')).toBe('export const card = 1;\n');
            const status = (await exec('git', ['status', '--porcelain'], { cwd: codeRoot })).stdout;
            expect(status.trim()).toBe('');
        });

        it("preserves an operator's uncommitted edit to an untouched file across a successful landMerge", async () => {
            const worktree = await manager.create('0001', 'card/0001-thing');
            await writeFile(join(worktree.path, 'src', 'card.ts'), 'export const card = 1;\n', 'utf8');
            await manager.commit(worktree, '0001: implementing');
            const computed = await manager.computeMerge('card/0001-thing', 'main');
            if (!computed.ok) throw new Error('expected a clean merge');
            const mergeSha = await manager.commitMerge(computed.targetSha, computed.branchSha, computed.treeSha, 'Merge card 0001: thing');

            // An operator's own in-progress edit, sitting uncommitted in codeRoot on a path the
            // merge never touches.
            await writeFile(join(codeRoot, 'src', 'operator-scratch.ts'), 'export const scratch = 1;\n', 'utf8');

            const result = await manager.landMerge(computed.targetSha, mergeSha, 'main');

            expect(result).toEqual({ ok: true });
            expect(await readFile(join(codeRoot, 'src', 'operator-scratch.ts'), 'utf8')).toBe('export const scratch = 1;\n');
            const status = (await exec('git', ['status', '--porcelain'], { cwd: codeRoot })).stdout;
            expect(status.trim()).toBe('?? src/operator-scratch.ts');
        });

        it('refuses rather than clobber an uncommitted edit that conflicts with the merge, leaving it on disk untouched', async () => {
            const worktree = await manager.create('0001', 'card/0001-thing');
            await writeFile(join(worktree.path, 'src', 'index.ts'), 'export const x = 2;\n', 'utf8');
            await manager.commit(worktree, '0001: implementing');
            const computed = await manager.computeMerge('card/0001-thing', 'main');
            if (!computed.ok) throw new Error('expected a clean merge');
            const mergeSha = await manager.commitMerge(computed.targetSha, computed.branchSha, computed.treeSha, 'Merge card 0001: thing');

            // An operator's own uncommitted edit to the very file the merge also changes — read-tree
            // must refuse rather than overwrite this (card 0143's Constraints: "do not use git reset
            // --hard; it would destroy exactly the uncommitted work this must preserve").
            await writeFile(join(codeRoot, 'src', 'index.ts'), 'export const x = 99;\n', 'utf8');

            const result = await manager.landMerge(computed.targetSha, mergeSha, 'main');

            expect(result.ok).toBe(false);
            if (result.ok) throw new Error('expected landMerge to refuse');
            expect(result.reason).toContain('could not be reconciled');
            // The ref already moved by this point — read-tree runs after update-ref succeeds — but
            // the operator's uncommitted edit must survive on disk regardless, exactly as it was.
            const head = (await exec('git', ['rev-parse', 'refs/heads/main'], { cwd: codeRoot })).stdout.trim();
            expect(head).toBe(mergeSha);
            expect(await readFile(join(codeRoot, 'src', 'index.ts'), 'utf8')).toBe('export const x = 99;\n');
        });

        it('refuses rather than clobbers when main moved since the merge was computed', async () => {
            const worktree = await manager.create('0001', 'card/0001-thing');
            await writeFile(join(worktree.path, 'src', 'card.ts'), 'export const card = 1;\n', 'utf8');
            await manager.commit(worktree, '0001: implementing');
            const computed = await manager.computeMerge('card/0001-thing', 'main');
            if (!computed.ok) throw new Error('expected a clean merge');
            const mergeSha = await manager.commitMerge(computed.targetSha, computed.branchSha, computed.treeSha, 'Merge card 0001: thing');

            // main moves on with something else after the merge was computed and committed.
            await writeFile(join(codeRoot, 'src', 'landed-meanwhile.ts'), 'export const landed = 1;\n', 'utf8');
            await exec('git', ['add', '-A'], { cwd: codeRoot });
            await exec('git', ['commit', '-q', '-m', 'landed while the merge was in flight'], { cwd: codeRoot });
            const movedMain = (await exec('git', ['rev-parse', 'HEAD'], { cwd: codeRoot })).stdout.trim();

            const result = await manager.landMerge(computed.targetSha, mergeSha, 'main');

            expect(result.ok).toBe(false);
            // main was left exactly where it moved to, not clobbered with the stale merge commit.
            const head = (await exec('git', ['rev-parse', 'refs/heads/main'], { cwd: codeRoot })).stdout.trim();
            expect(head).toBe(movedMain);
            expect(head).not.toBe(mergeSha);
        });
    });

    /**
     * Card 0144. `ensureIntegrationBranch` is the throwaway branch a dry-run merge lands on instead
     * of `main` — cut once from `main`, then left exactly where the last dry-run merge put it so a
     * dependent card's rehearsal sees its dependency's rehearsed result on it.
     */
    describe('ensureIntegrationBranch', () => {
        it('cuts dry-run-integration from main the first time it is asked for', async () => {
            const mainSha = (await exec('git', ['rev-parse', 'main'], { cwd: codeRoot })).stdout.trim();

            const branch = await manager.ensureIntegrationBranch();

            expect(branch).toBe('dry-run-integration');
            const tip = (await exec('git', ['rev-parse', 'refs/heads/dry-run-integration'], { cwd: codeRoot })).stdout.trim();
            expect(tip).toBe(mainSha);
        });

        it('is idempotent, and never resets the branch back to main once main has moved past it', async () => {
            await manager.ensureIntegrationBranch();
            const worktree = await manager.create('0001', 'card/0001-thing');
            await writeFile(join(worktree.path, 'src', 'card.ts'), 'export const card = 1;\n', 'utf8');
            await manager.commit(worktree, '0001: implementing');
            const computed = await manager.computeMerge('card/0001-thing', 'dry-run-integration');
            if (!computed.ok) throw new Error('expected a clean merge');
            const mergeSha = await manager.commitMerge(computed.targetSha, computed.branchSha, computed.treeSha, 'Merge card 0001: thing');
            await manager.landMerge(computed.targetSha, mergeSha, 'dry-run-integration');

            // main moves on with something unrelated, after the integration branch already carries
            // card 0001's dry-run merge.
            await writeFile(join(codeRoot, 'src', 'unrelated.ts'), 'export const unrelated = 1;\n', 'utf8');
            await exec('git', ['add', '-A'], { cwd: codeRoot });
            await exec('git', ['commit', '-q', '-m', 'unrelated main commit'], { cwd: codeRoot });

            const branch = await manager.ensureIntegrationBranch();

            expect(branch).toBe('dry-run-integration');
            const tip = (await exec('git', ['rev-parse', 'refs/heads/dry-run-integration'], { cwd: codeRoot })).stdout.trim();
            // Still the merge commit from card 0001 — not reset to main's new tip, and not moved at
            // all. Composing across dry runs is the entire point (this card's Constraints).
            expect(tip).toBe(mergeSha);
        });
    });

    /**
     * Card 0144. `computeMerge` and `landMerge` generalized to take any ref, not just `main` — these
     * exercise them against the integration branch, the second caller besides `main` that now exists,
     * and prove `main` is never read with anything that could move it in the process.
     */
    describe('computeMerge and landMerge against a ref other than main', () => {
        it('computes and lands a merge onto the integration branch without moving main at all', async () => {
            await manager.ensureIntegrationBranch();
            const mainBefore = (await exec('git', ['rev-parse', 'main'], { cwd: codeRoot })).stdout.trim();

            const worktree = await manager.create('0001', 'card/0001-thing');
            await writeFile(join(worktree.path, 'src', 'card.ts'), 'export const card = 1;\n', 'utf8');
            await manager.commit(worktree, '0001: implementing');

            const computed = await manager.computeMerge('card/0001-thing', 'dry-run-integration');
            if (!computed.ok) throw new Error('expected a clean merge');
            const mergeSha = await manager.commitMerge(computed.targetSha, computed.branchSha, computed.treeSha, 'Merge card 0001: thing (dry run)');
            const result = await manager.landMerge(computed.targetSha, mergeSha, 'dry-run-integration');

            expect(result).toEqual({ ok: true });
            const integrationTip = (await exec('git', ['rev-parse', 'refs/heads/dry-run-integration'], { cwd: codeRoot })).stdout.trim();
            expect(integrationTip).toBe(mergeSha);
            const cardFile = await exec('git', ['show', 'refs/heads/dry-run-integration:src/card.ts'], { cwd: codeRoot });
            expect(cardFile.stdout).toBe('export const card = 1;\n');

            // main itself never moved.
            const mainAfter = (await exec('git', ['rev-parse', 'main'], { cwd: codeRoot })).stdout.trim();
            expect(mainAfter).toBe(mainBefore);
        });

        it('never runs read-tree for a target that is not checked out, even when landing would conflict with an uncommitted edit sitting in codeRoot', async () => {
            await manager.ensureIntegrationBranch();

            const worktree = await manager.create('0001', 'card/0001-thing');
            await writeFile(join(worktree.path, 'src', 'index.ts'), 'export const x = 2;\n', 'utf8');
            await manager.commit(worktree, '0001: implementing');
            const computed = await manager.computeMerge('card/0001-thing', 'dry-run-integration');
            if (!computed.ok) throw new Error('expected a clean merge');
            const mergeSha = await manager.commitMerge(computed.targetSha, computed.branchSha, computed.treeSha, 'Merge card 0001: thing (dry run)');

            // An edit sitting uncommitted in codeRoot that conflicts with the very file the dry-run
            // merge also changes. `codeRoot` is checked out at `main`, not the integration branch —
            // if landMerge ran read-tree here the way it does for main, this conflicting edit would
            // make it refuse. It must not even try: the integration branch is never checked out
            // anywhere, so there is nothing to reconcile.
            await writeFile(join(codeRoot, 'src', 'index.ts'), 'export const x = 99;\n', 'utf8');

            const result = await manager.landMerge(computed.targetSha, mergeSha, 'dry-run-integration');

            expect(result).toEqual({ ok: true });
            // codeRoot's checkout is completely undisturbed: still on main, still carrying the
            // operator's uncommitted edit exactly as it was, untouched by a rehearsal landing
            // elsewhere.
            const branch = (await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: codeRoot })).stdout.trim();
            expect(branch).toBe('main');
            expect(await readFile(join(codeRoot, 'src', 'index.ts'), 'utf8')).toBe('export const x = 99;\n');
            const status = (await exec('git', ['status', '--porcelain'], { cwd: codeRoot })).stdout;
            expect(status.trim()).toBe('M src/index.ts');
        });
    });

    /**
     * Card 0238. `overlapSinceFork` is the git behind `merge`'s re-review check: the merge-base of
     * `branch` and `targetRef`, plus the intersection of what each side changed since it — the paths
     * a combined diff would show that a single-sided review would not. `board.write.service.test.ts`
     * doubles this method for its own re-review decision tests; these exercise the real git behind it.
     */
    describe('overlapSinceFork', () => {
        it('returns the merge-base and only the paths both sides changed since it, sorted', async () => {
            const worktree = await manager.create('0001', 'card/0001-thing');
            const base = worktree.baseSha;

            // The branch touches three files — two out of alphabetical order, to prove the
            // intersection comes back sorted — plus one only it touches.
            await writeFile(join(worktree.path, 'src', 'zeta.ts'), 'export const zeta = 1;\n', 'utf8');
            await writeFile(join(worktree.path, 'src', 'alpha.ts'), 'export const alpha = 1;\n', 'utf8');
            await writeFile(join(worktree.path, 'src', 'only-branch.ts'), 'export const onlyBranch = 1;\n', 'utf8');
            await manager.commit(worktree, '0001: implementing');

            // main moves too: the same two files (differently), plus one the branch never touched.
            await writeFile(join(codeRoot, 'src', 'zeta.ts'), 'export const zeta = 2;\n', 'utf8');
            await writeFile(join(codeRoot, 'src', 'alpha.ts'), 'export const alpha = 2;\n', 'utf8');
            await writeFile(join(codeRoot, 'src', 'only-main.ts'), 'export const onlyMain = 1;\n', 'utf8');
            await exec('git', ['add', '-A'], { cwd: codeRoot });
            await exec('git', ['commit', '-q', '-m', 'main moved'], { cwd: codeRoot });

            const result = await manager.overlapSinceFork('card/0001-thing', 'main');

            expect(result.base).toBe(base);
            expect(result.movedUnder).toEqual(['src/alpha.ts', 'src/zeta.ts']);
        });

        it('returns an empty intersection when the branch has changes but main has not moved at all', async () => {
            const worktree = await manager.create('0001', 'card/0001-thing');
            await writeFile(join(worktree.path, 'src', 'card.ts'), 'export const card = 1;\n', 'utf8');
            await manager.commit(worktree, '0001: implementing');

            const result = await manager.overlapSinceFork('card/0001-thing', 'main');

            expect(result.movedUnder).toEqual([]);
        });

        it('returns an empty intersection when main moved only in files the branch never touched', async () => {
            const worktree = await manager.create('0001', 'card/0001-thing');
            await writeFile(join(worktree.path, 'src', 'card.ts'), 'export const card = 1;\n', 'utf8');
            await manager.commit(worktree, '0001: implementing');

            await writeFile(join(codeRoot, 'src', 'only-main.ts'), 'export const onlyMain = 1;\n', 'utf8');
            await exec('git', ['add', '-A'], { cwd: codeRoot });
            await exec('git', ['commit', '-q', '-m', 'main moved elsewhere'], { cwd: codeRoot });

            const result = await manager.overlapSinceFork('card/0001-thing', 'main');

            expect(result.movedUnder).toEqual([]);
        });

        it('reads against codeRoot without moving its checkout or dirtying its working tree', async () => {
            const worktree = await manager.create('0001', 'card/0001-thing');
            await writeFile(join(worktree.path, 'src', 'card.ts'), 'export const card = 1;\n', 'utf8');
            await manager.commit(worktree, '0001: implementing');

            await manager.overlapSinceFork('card/0001-thing', 'main');

            const branch = (await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: codeRoot })).stdout.trim();
            expect(branch).toBe('main');
            const status = (await exec('git', ['status', '--porcelain'], { cwd: codeRoot })).stdout;
            expect(status.trim()).toBe('');
        });
    });

    describe('headSha', () => {
        // Card 0103: a caller that gets `{ ok: false }` back from `rebaseOntoHead` needs the exact
        // commit the rebase was attempted against, without `rebaseOntoHead` itself having to return
        // it — this is that second, independent read.
        it("reports the code repo's current HEAD", async () => {
            const head = (await exec('git', ['rev-parse', 'HEAD'], { cwd: codeRoot })).stdout.trim();
            await expect(manager.headSha()).resolves.toBe(head);
        });

        it('moves with HEAD once another commit lands on the code repo', async () => {
            const before = await manager.headSha();

            await writeFile(join(codeRoot, 'src', 'later.ts'), 'export const later = 1;\n', 'utf8');
            await exec('git', ['add', '-A'], { cwd: codeRoot });
            await exec('git', ['commit', '-q', '-m', 'later'], { cwd: codeRoot });

            const after = await manager.headSha();
            const headNow = (await exec('git', ['rev-parse', 'HEAD'], { cwd: codeRoot })).stdout.trim();
            expect(after).not.toBe(before);
            expect(after).toBe(headNow);
        });
    });

    /**
     * Card 0265. The diff behind `ready`'s human gate, read without a terminal: every file `branch`
     * changed since `merge-base(targetRef, branch)`, as unified patch text — one basis for the diff
     * `wilson card diff` already uses. These assertions fail on the pre-change tree: `patchSinceFork`
     * does not exist there.
     */
    describe('patchSinceFork', () => {
        it("reports the merge-base and a modified file's patch, excluding a file main only gained after the fork (AC1)", async () => {
            const worktree = await manager.create('0001', 'card/0001-thing');
            const base = worktree.baseSha;
            await writeFile(join(worktree.path, 'src', 'index.ts'), 'export const x = 2;\n', 'utf8');
            await manager.commit(worktree, '0001: implementing');

            // main moves on with a file the branch never saw. `main..branch` would report this as a
            // deletion the card never made; `merge-base(main, branch)..branch` must not.
            await writeFile(join(codeRoot, 'src', 'landed.ts'), 'export const landed = 1;\n', 'utf8');
            await exec('git', ['add', '-A'], { cwd: codeRoot });
            await exec('git', ['commit', '-q', '-m', 'landed on main'], { cwd: codeRoot });

            const result = await manager.patchSinceFork('card/0001-thing', 'main');

            expect(result.ok).toBe(true);
            if (!result.ok) throw new Error('expected ok');
            expect(result.base).toBe(base);
            expect(result.files).toHaveLength(1);
            expect(result.files[0].path).toBe('src/index.ts');
            expect(result.files[0].status).toBe('modified');
            expect(result.files[0].patch).toContain('-export const x = 1;');
            expect(result.files[0].patch).toContain('+export const x = 2;');
            expect(result.files.some(f => f.path === 'src/landed.ts')).toBe(false);
            expect(result.truncated).toBe(false);
        });

        it('refuses by name, naming the branch, when it has never been cut (AC2)', async () => {
            const result = await manager.patchSinceFork('card/9999-never-cut', 'main');

            expect(result.ok).toBe(false);
            if (result.ok) throw new Error('expected a refusal');
            expect(result.reason).toContain('card/9999-never-cut');
        });

        it('returns an empty files array, distinct from a refusal, for a branch that exists but changed nothing (AC3)', async () => {
            await manager.create('0001', 'card/0001-thing');

            const result = await manager.patchSinceFork('card/0001-thing', 'main');

            expect(result).toMatchObject({ ok: true, files: [] });
        });

        it('reports an added file and a deleted file with their own status', async () => {
            const worktree = await manager.create('0001', 'card/0001-thing');
            await writeFile(join(worktree.path, 'src', 'added.ts'), 'export const added = 1;\n', 'utf8');
            await exec('git', ['rm', '-q', 'src/index.ts'], { cwd: worktree.path });
            await manager.commit(worktree, '0001: implementing');

            const result = await manager.patchSinceFork('card/0001-thing', 'main');

            if (!result.ok) throw new Error('expected ok');
            const byPath = Object.fromEntries(result.files.map(f => [f.path, f.status]));
            expect(byPath['src/added.ts']).toBe('added');
            expect(byPath['src/index.ts']).toBe('deleted');
        });

        // This card's Constraints: `--no-renames` throughout, so a rename reads as a delete and an
        // add — matching what `changedPaths`/the reviewer's own basis already see.
        it('reports a rename as a delete and an add, never as a rename', async () => {
            const worktree = await manager.create('0001', 'card/0001-thing');
            await exec('git', ['mv', 'src/index.ts', 'src/renamed.ts'], { cwd: worktree.path });
            await manager.commit(worktree, '0001: implementing');

            const result = await manager.patchSinceFork('card/0001-thing', 'main');

            if (!result.ok) throw new Error('expected ok');
            const byPath = Object.fromEntries(result.files.map(f => [f.path, f.status]));
            expect(byPath['src/index.ts']).toBe('deleted');
            expect(byPath['src/renamed.ts']).toBe('added');
        });

        it("answers for a card whose worktree has already been reclaimed (AC7)", async () => {
            const worktree = await manager.create('0001', 'card/0001-thing');
            await writeFile(join(worktree.path, 'src', 'feature.ts'), 'export const feature = 1;\n', 'utf8');
            await manager.commit(worktree, '0001: implementing');
            await manager.reclaim('0001');
            expect(existsSync(worktree.path)).toBe(false);

            const result = await manager.patchSinceFork('card/0001-thing', 'main');

            expect(result.ok).toBe(true);
            if (!result.ok) throw new Error('expected ok');
            expect(result.files.map(f => f.path)).toEqual(['src/feature.ts']);
        });

        // Bounded response, this card's Constraints: a file whose own patch exceeds the per-file cap
        // (256 KB) comes back with an empty patch and truncated: true, and does not by itself trip
        // the response-level flag.
        it('truncates a single file whose own patch exceeds the per-file cap, without setting the response-level flag (AC4)', async () => {
            const worktree = await manager.create('0001', 'card/0001-thing');
            const huge = 'x'.repeat(300 * 1024);
            await writeFile(join(worktree.path, 'src', 'huge.ts'), `export const huge = '${huge}';\n`, 'utf8');
            await manager.commit(worktree, '0001: implementing');

            const result = await manager.patchSinceFork('card/0001-thing', 'main');

            if (!result.ok) throw new Error('expected ok');
            const hugeFile = result.files.find(f => f.path === 'src/huge.ts');
            expect(hugeFile).toMatchObject({ patch: '', truncated: true });
            expect(result.truncated).toBe(false);
        });

        it('stops adding patch text and sets the response-level flag once the total 2 MB budget is spent (AC4)', async () => {
            const worktree = await manager.create('0001', 'card/0001-thing');
            // Nine files, each safely under the 256 KB per-file cap on its own, but past the 2 MB
            // total budget together — the ninth is the one that tips it over.
            for (let i = 0; i < 9; i++) {
                await writeFile(join(worktree.path, 'src', `big-${i}.ts`), `export const big = '${'x'.repeat(240 * 1024)}';\n`, 'utf8');
            }
            await manager.commit(worktree, '0001: implementing');

            const result = await manager.patchSinceFork('card/0001-thing', 'main');

            if (!result.ok) throw new Error('expected ok');
            expect(result.truncated).toBe(true);
            const cutOff = result.files.filter(f => f.truncated);
            expect(cutOff.length).toBeGreaterThan(0);
            cutOff.forEach(f => expect(f.patch).toBe(''));
            // At least one file's real patch text made it in before the budget ran out.
            expect(result.files.some(f => !f.truncated && f.patch.length > 0)).toBe(true);
        });

        it('reads against codeRoot without moving its checkout or dirtying its working tree (no worktree cut, resumed or reclaimed)', async () => {
            const worktree = await manager.create('0001', 'card/0001-thing');
            await writeFile(join(worktree.path, 'src', 'card.ts'), 'export const card = 1;\n', 'utf8');
            await manager.commit(worktree, '0001: implementing');

            await manager.patchSinceFork('card/0001-thing', 'main');

            const branch = (await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: codeRoot })).stdout.trim();
            expect(branch).toBe('main');
            const status = (await exec('git', ['status', '--porcelain'], { cwd: codeRoot })).stdout;
            expect(status.trim()).toBe('');
        });
    });
});
