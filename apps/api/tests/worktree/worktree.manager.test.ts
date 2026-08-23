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
