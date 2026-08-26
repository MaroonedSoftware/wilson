import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeEach, describe, expect, it } from 'vitest';
import { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';

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

        const config = new StaticBoardConfig('test', join(base, 'board'), codeRoot, join(base, 'worktrees'), join(base, 'run'));
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

    it('removes the directory and prunes git bookkeeping on reclaim', async () => {
        const worktree = await manager.create('0001', 'card/0001-thing');
        await manager.reclaim('0001');

        expect(existsSync(worktree.path)).toBe(false);
        // git's own bookkeeping must be pruned too, or the next `worktree add` refuses the path.
        const { stdout } = await exec('git', ['worktree', 'list'], { cwd: codeRoot });
        expect(stdout).not.toContain('0001');
    });

    describe('commit', () => {
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
});
