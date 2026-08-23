import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ScopeGuard } from '#modules/agent/scope.guard.js';

/**
 * The guard is the single enforcement point for scope, and everything downstream trusts it
 * silently. These tests are weighted towards the ways it could be bypassed rather than the ways it
 * is meant to be used.
 */
describe('ScopeGuard', () => {
    let root: string;
    let outside: string;

    const guard = (allow: string[], alwaysAllowed: string[] = [], deny: string[] = []) =>
        new ScopeGuard({ worktreeRoot: root, allow, alwaysAllowed, deny });

    beforeAll(async () => {
        const base = await mkdtemp(join(tmpdir(), 'scope-guard-'));
        root = join(base, 'worktree');
        outside = join(base, 'outside');
        await mkdir(join(root, 'src', 'runner'), { recursive: true });
        await mkdir(join(root, '.runner'), { recursive: true });
        await mkdir(outside, { recursive: true });
        await writeFile(join(root, 'src', 'runner', 'existing.ts'), 'x', 'utf8');
        await writeFile(join(outside, 'secret.txt'), 'x', 'utf8');
        await symlink(outside, join(root, 'escape'));
    });

    it('allows a path matching a scope glob', async () => {
        await expect(guard(['src/runner/**']).check('src/runner/new.ts')).resolves.toMatchObject({ allowed: true });
    });

    it('allows a file that does not exist yet, so a create is not blocked', async () => {
        await expect(guard(['src/runner/**']).check('src/runner/deep/nested/new.ts')).resolves.toMatchObject({ allowed: true });
    });

    it('denies a path outside the scope globs', async () => {
        const decision = await guard(['src/runner/**']).check('src/other/thing.ts');
        expect(decision.allowed).toBe(false);
    });

    it('denies everything when the plan declares no scope', async () => {
        // Silence is not permission: a plan that has not said what it may touch may touch nothing.
        const decision = await guard([]).check('src/runner/new.ts');
        expect(decision.allowed).toBe(false);
    });

    it('denies the machinery even when a glob would allow it', async () => {
        const decision = await guard(['**']).check('.runner/state.json');
        expect(decision).toMatchObject({ allowed: false });
        expect((decision as { reason: string }).reason).toContain('denied');
    });

    it('denies stage config even when a glob would allow it', async () => {
        await expect(guard(['**']).check('config/stages.yaml')).resolves.toMatchObject({ allowed: false });
    });

    it('refuses a relative traversal that climbs out of the worktree', async () => {
        const decision = await guard(['**']).check('src/../../outside/secret.txt');
        expect(decision).toMatchObject({ allowed: false });
        expect((decision as { reason: string }).reason).toContain('outside the worktree');
    });

    it('refuses an absolute path outside the worktree', async () => {
        await expect(guard(['**']).check(join(outside, 'secret.txt'))).resolves.toMatchObject({ allowed: false });
    });

    it('refuses a write through a symlink that points outside the worktree', async () => {
        // The glob `**` matches `escape/secret.txt` happily; only resolving the link catches it.
        const decision = await guard(['**']).check('escape/secret.txt');
        expect(decision).toMatchObject({ allowed: false });
        expect((decision as { reason: string }).reason).toContain('outside the worktree');
    });

    it('refuses the worktree root itself', async () => {
        await expect(guard(['**']).check('.')).resolves.toMatchObject({ allowed: false });
    });

    it('allows machine-owned paths without the plan mentioning them', async () => {
        await expect(guard(['src/**'], ['pnpm-lock.yaml']).check('pnpm-lock.yaml')).resolves.toMatchObject({ allowed: true });
    });

    it('honours project deny globs on top of the built-in ones', async () => {
        await expect(guard(['**'], [], ['src/generated/**']).check('src/generated/db.ts')).resolves.toMatchObject({ allowed: false });
    });

    describe('grants', () => {
        it('allows a path once it has been granted, and reports it', async () => {
            const g = guard(['src/runner/**']);
            expect((await g.check('docs/readme.md')).allowed).toBe(false);
            g.grant('docs/readme.md');
            expect((await g.check('docs/readme.md')).allowed).toBe(true);
            expect(g.grants()).toEqual(['docs/readme.md']);
        });

        it('does not let a grant override the deny list', async () => {
            const g = guard(['**']);
            g.grant('.runner/state.json');
            // Deny is checked first on purpose: no grant makes the machinery writable.
            await expect(g.check('.runner/state.json')).resolves.toMatchObject({ allowed: false });
        });
    });

    describe('checkRead', () => {
        it('allows reading outside the scope globs, since understanding is not changing', async () => {
            await expect(guard(['src/runner/**']).checkRead('src/other/thing.ts')).resolves.toMatchObject({ allowed: true });
        });

        it('still refuses to read outside the worktree', async () => {
            await expect(guard(['**']).checkRead('escape/secret.txt')).resolves.toMatchObject({ allowed: false });
        });

        it('still refuses to read the machinery', async () => {
            await expect(guard(['**']).checkRead('.runner/state.json')).resolves.toMatchObject({ allowed: false });
        });
    });
});
