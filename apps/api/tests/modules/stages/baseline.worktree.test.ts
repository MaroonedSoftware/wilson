import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withBaselineWorktree } from '#modules/stages/baseline.worktree.js';
import type { Worktree } from '#modules/worktree/worktree.manager.js';

describe('withBaselineWorktree', () => {
    const dirs: string[] = [];
    afterEach(() => {
        for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    const setUp = () => {
        const dir = mkdtempSync(join(tmpdir(), 'baseline-worktree-'));
        dirs.push(dir);
        const source: Worktree = { path: join(dir, 'card'), branch: 'card/0001', baseSha: 'abc123' };
        const worktrees = {
            create: vi.fn(async () => ({ path: dir, branch: 'card/0001-baseline', baseSha: 'abc123' })),
            reclaim: vi.fn(async () => {}),
        };
        return { dir, source, worktrees };
    };
    const logger = { info: () => {} };
    const failed = (reason: string) => `failed: ${reason}`;

    it("cuts at the source's base under its own id and reclaims it afterwards", async () => {
        const { dir, source, worktrees } = setUp();
        const seen = await withBaselineWorktree(worktrees, logger, { id: '0001-baseline', source, setupLabel: 'x' }, failed, async tree => tree.path);
        expect(seen).toBe(dir);
        expect(worktrees.create).toHaveBeenCalledWith('0001-baseline', 'card/0001-baseline', 'abc123', undefined);
        expect(worktrees.reclaim).toHaveBeenCalledWith('0001-baseline', undefined);
    });

    it('runs setup in the baseline tree before handing it over', async () => {
        const { dir, source, worktrees } = setUp();
        writeFileSync(join(dir, 'setup.sh'), '#!/bin/sh\ntouch prepared\n', { mode: 0o755 });
        const prepared = await withBaselineWorktree(
            worktrees,
            logger,
            { id: '0001-baseline', source, setupCommand: './setup.sh', setupLabel: 'x' },
            failed,
            async tree => (existsSync(join(tree.path, 'prepared')) ? 'yes' : 'no'),
        );
        expect(prepared).toBe('yes');
    });

    it('answers with onSetupFailure, skips use and still reclaims when setup fails', async () => {
        const { dir, source, worktrees } = setUp();
        writeFileSync(join(dir, 'setup.sh'), '#!/bin/sh\necho no lockfile\nexit 3\n', { mode: 0o755 });
        const use = vi.fn(async () => 'used');
        const result = await withBaselineWorktree(worktrees, logger, { id: 'b', source, setupCommand: './setup.sh', setupLabel: 'x' }, failed, use);
        expect(result).toContain('failed: `./setup.sh` failed (exit 3)');
        expect(result).toContain('no lockfile');
        expect(use).not.toHaveBeenCalled();
        expect(worktrees.reclaim).toHaveBeenCalledTimes(1);
    });

    it('refuses setup when no time is left, rather than starting an install it would kill', async () => {
        const { dir, source, worktrees } = setUp();
        writeFileSync(join(dir, 'setup.sh'), '#!/bin/sh\ntouch started\n', { mode: 0o755 });
        const result = await withBaselineWorktree(
            worktrees,
            logger,
            { id: 'b', source, setupCommand: './setup.sh', setupLabel: 'x', setupTimeoutMs: () => 0 },
            failed,
            async () => 'used',
        );
        expect(result).toContain('no time was left');
        expect(existsSync(join(dir, 'started'))).toBe(false);
    });

    it('reclaims when use throws', async () => {
        const { source, worktrees } = setUp();
        await expect(
            withBaselineWorktree(worktrees, logger, { id: 'b', source, setupLabel: 'x' }, failed, async () => {
                throw new Error('boom');
            }),
        ).rejects.toThrow('boom');
        expect(worktrees.reclaim).toHaveBeenCalledTimes(1);
    });
});
