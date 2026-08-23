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

        it('refuses when the branch does not exist, naming the likely cause', async () => {
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
});
