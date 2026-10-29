import { describe, expect, it } from 'vitest';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { localHost } from '#modules/host/local.execution.host.js';
import { runConfiguredCommand } from '#modules/stages/run.command.js';
import { WorktreeManager, worktreeHost, type Worktree } from '#modules/worktree/worktree.manager.js';
import { MemoryHost } from '#tests/support/memory.host.js';

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/**
 * The git a stage's own worktree needs (staging, committing, listing what changed) runs where that
 * worktree is. A worktree on a `MemoryHost` has no directory on this machine, so any of these
 * reaching for local git would fail rather than pass.
 */
describe('a worktree’s own git work runs on its host', () => {
    const manager = new WorktreeManager(new StaticBoardConfig('p', '/nowhere/code', '/nowhere/worktrees', '/nowhere/run'), logger as never);

    it('defaults to this machine for a worktree that names no host', () => {
        expect(worktreeHost({ path: '/x', branch: 'b', baseSha: 'abc' })).toBe(localHost);
    });

    it('stages and commits on the host, and returns the sha it reports', async () => {
        const host = new MemoryHost((_, args) => {
            if (args[0] === 'diff') return { stdout: 'src/a.ts\n', stderr: '' };
            if (args[0] === 'rev-parse') return { stdout: 'f00d\n', stderr: '' };
            return { stdout: '', stderr: '' };
        });
        const worktree: Worktree = { path: '/remote/wt/0001', branch: 'card/0001', baseSha: 'abc', host };

        const sha = await manager.commit(worktree, '0001: implementing');

        expect(sha).toBe('f00d');
        expect(host.commands.map(c => [c.args[0], c.options.cwd])).toEqual([
            ['add', '/remote/wt/0001'],
            ['diff', '/remote/wt/0001'],
            ['commit', '/remote/wt/0001'],
            ['rev-parse', '/remote/wt/0001'],
        ]);
    });

    it('lists changed, added and uncommitted paths from the host', async () => {
        const host = new MemoryHost((_, args) => {
            if (args[0] === 'diff' && args[1] === '--name-only') return { stdout: 'src/a.ts\n', stderr: '' };
            if (args[0] === 'diff' && args[1] === '--name-status') return { stdout: 'A\tsrc/new.ts\nM\tsrc/a.ts\n', stderr: '' };
            if (args[0] === 'ls-files') return { stdout: 'src/untracked.ts\n', stderr: '' };
            if (args[0] === 'status') return { stdout: ' M src/a.ts\n?? src/untracked.ts\n', stderr: '' };
            return { stdout: '', stderr: '' };
        });
        const worktree: Worktree = { path: '/remote/wt/0001', branch: 'card/0001', baseSha: 'abc', host };

        expect(await manager.changedPaths(worktree)).toEqual(['src/a.ts', 'src/untracked.ts']);
        expect(await manager.addedPaths(worktree)).toEqual(['src/new.ts', 'src/untracked.ts']);
        expect(await manager.uncommittedPaths(worktree)).toEqual(['src/a.ts', 'src/untracked.ts']);
        expect(host.commands.every(c => c.file === 'git' && c.options.cwd === '/remote/wt/0001')).toBe(true);
    });

    it('runs a configured command on the host it is given, and reports a failure the same way', async () => {
        const host = new MemoryHost();
        expect(await runConfiguredCommand('/remote/wt/0001', 'pnpm build', undefined, 4100, host)).toBeUndefined();
        expect(host.commands[0]).toMatchObject({ file: 'pnpm', args: ['build'], options: { cwd: '/remote/wt/0001' } });
        expect(host.commands[0]!.options.env?.PORT).toBe('4100');

        const failing = new MemoryHost(() => {
            throw Object.assign(new Error('boom'), { code: 2, stdout: 'out', stderr: 'err' });
        });
        const failure = await runConfiguredCommand('/remote/wt/0001', 'pnpm build', undefined, undefined, failing);
        expect(failure?.reason).toContain('failed (exit 2)');
        expect(failure?.reason).toContain('out\nerr');
    });
});
