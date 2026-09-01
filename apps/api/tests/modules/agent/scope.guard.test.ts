import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { REPORT_RESULT_PATH, SCRATCH_PREFIX, ScopeGuard } from '#modules/agent/scope.guard.js';

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

    it('says request_scope cannot widen the deny list, so an agent does not waste a round trip asking', async () => {
        const decision = await guard(['**']).check('.runner/state.json');
        expect(decision).toMatchObject({ allowed: false });
        expect((decision as { reason: string }).reason).toBe(
            'path is denied: the runner owns it, not the plan — request_scope cannot widen it, so work through a different path',
        );
    });

    it('tells the caller to call request_scope, in the out-of-scope fallback refusal', async () => {
        const decision = await guard(['src/runner/**']).check('src/other/thing.ts');
        expect(decision).toMatchObject({ allowed: false });
        expect((decision as { reason: string }).reason).toBe(
            'path is outside the plan’s files in scope — call request_scope with this path if the work genuinely needs it',
        );
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
            await g.grant('docs/readme.md');
            expect((await g.check('docs/readme.md')).allowed).toBe(true);
            expect(g.grants()).toEqual(['docs/readme.md']);
        });

        it('refuses to grant the deny list', async () => {
            const g = guard(['**']);
            await expect(g.grant('.runner/state.json')).resolves.toMatchObject({ allowed: false });
            await expect(g.check('.runner/state.json')).resolves.toMatchObject({ allowed: false });
            expect(g.grants()).toEqual([]);
        });

        it('says request_scope cannot widen the deny list from grant() too', async () => {
            const decision = await guard(['**']).grant('.runner/state.json');
            expect(decision).toMatchObject({ allowed: false });
            expect((decision as { reason: string }).reason).toContain('request_scope cannot widen it');
        });

        it('refuses to grant a path outside the worktree, rather than recording a lie', async () => {
            // A grant containment would still refuse reads to the operator as a widening that
            // happened. It did not, and no write to it will ever succeed.
            const g = guard(['**']);
            await expect(g.grant(join(outside, 'secret.txt'))).resolves.toMatchObject({ allowed: false });
            expect(g.grants()).toEqual([]);
        });
    });

    describe('readable extras', () => {
        const withPlan = (plan: string) => new ScopeGuard({ worktreeRoot: root, allow: ['src/**'], alwaysAllowed: [], readableExtras: [plan] });

        it('allows reading the plan even though it lives outside the worktree', async () => {
            // The plan is materialized outside the tree so it can never be committed to the card's
            // branch. Without this exception it is also unreadable, and the agent — as card 0001
            // proved — infers its own contract and violates the plan's out-of-scope section.
            const plan = join(outside, 'plan.md');
            await expect(withPlan(plan).checkRead(plan)).resolves.toMatchObject({ allowed: true, path: plan });
        });

        it('does not make the plan writable', async () => {
            const plan = join(outside, 'plan.md');
            await expect(withPlan(plan).check(plan)).resolves.toMatchObject({ allowed: false });
        });

        it('does not admit its siblings', async () => {
            // Exact file paths only: an extra is not a directory grant.
            await expect(withPlan(join(outside, 'plan.md')).checkRead(join(outside, 'secret.txt'))).resolves.toMatchObject({ allowed: false });
        });
    });

    describe('collateral', () => {
        const guardWithCollateral = (allow: string[], collateral: string[]) => new ScopeGuard({ worktreeRoot: root, allow, alwaysAllowed: [], collateral });

        it('allows a write to a path outside scope when it is listed as collateral, and reports via collateral', async () => {
            const g = guardWithCollateral(['src/runner/**'], ['src/other/thing.ts']);

            const decision = await g.check('src/other/thing.ts');

            expect(decision).toMatchObject({ allowed: true, path: 'src/other/thing.ts', via: 'collateral' });
            expect(g.collateralHits()).toEqual(['src/other/thing.ts']);
        });

        it('still denies a path that is neither in scope nor listed as collateral', async () => {
            const g = guardWithCollateral(['src/runner/**'], ['src/other/thing.ts']);

            const decision = await g.check('src/unrelated/thing.ts');

            expect(decision.allowed).toBe(false);
            expect(g.collateralHits()).toEqual([]);
        });

        it('reports a path matched by the scope glob as via scope, not as a collateral hit, even when it is also listed as collateral', async () => {
            // The two lists can legitimately overlap (a scoped file that also happens to import
            // another scoped file); the report should not count that as a widening.
            const g = guardWithCollateral(['src/other/**'], ['src/other/thing.ts']);

            const decision = await g.check('src/other/thing.ts');

            expect(decision).toMatchObject({ allowed: true, via: 'scope' });
            expect(g.collateralHits()).toEqual([]);
        });

        it('still refuses a collateral path that matches the deny list, and does not record a hit for it', async () => {
            const g = guardWithCollateral(['**'], ['.runner/state.json']);

            const decision = await g.check('.runner/state.json');

            expect(decision).toMatchObject({ allowed: false });
            expect(g.collateralHits()).toEqual([]);
        });

        it('reports an explicit grant as via grant even when the same path is also listed as collateral', async () => {
            const g = guardWithCollateral([], ['src/other/thing.ts']);
            await g.grant('src/other/thing.ts');

            const decision = await g.check('src/other/thing.ts');

            expect(decision).toMatchObject({ allowed: true, via: 'grant' });
            expect(g.collateralHits()).toEqual([]);
        });

        it('accumulates every distinct collateral path actually used, without duplicates, sorted', async () => {
            const g = guardWithCollateral([], ['src/other/b.ts', 'src/other/a.ts']);

            await g.check('src/other/b.ts');
            await g.check('src/other/a.ts');
            await g.check('src/other/b.ts');

            expect(g.collateralHits()).toEqual(['src/other/a.ts', 'src/other/b.ts']);
        });

        it('does not report a collateral hit for a path that was only checked, never actually collateral-matched', async () => {
            // Reading is unaffected by collateral — checkRead already allows anything inside the
            // worktree — but a failed check() must not be mistaken for a widening either.
            const g = guardWithCollateral(['src/runner/**'], []);

            await g.check('src/other/thing.ts');

            expect(g.collateralHits()).toEqual([]);
        });

        it('defaults to no collateral at all when the option is omitted', async () => {
            const g = new ScopeGuard({ worktreeRoot: root, allow: ['src/runner/**'], alwaysAllowed: [] });

            const decision = await g.check('src/other/thing.ts');

            expect(decision.allowed).toBe(false);
            expect(g.collateralHits()).toEqual([]);
        });
    });

    describe('the report_result channel (card 0073)', () => {
        // `report_result` now carries only a path — the file it points at is the whole of the
        // stage's result — so `ScopeGuard` has to let that one fixed, code-owned name through a
        // write without the plan ever having declared it, while still refusing to let a plan claim
        // the same name for itself through request_scope.

        it('allows a write to the report path even though no scope glob covers it', async () => {
            // An empty allow list denies everything else (see the test above), which is exactly why
            // this has to be a special case rather than something a project could achieve by adding
            // the name to `alwaysAllowed`.
            await expect(guard([]).check(REPORT_RESULT_PATH)).resolves.toMatchObject({ allowed: true, path: REPORT_RESULT_PATH, via: 'scope' });
        });

        it('allows the report path even where the deny list would otherwise be checked first', async () => {
            await expect(guard(['**']).check(REPORT_RESULT_PATH)).resolves.toMatchObject({ allowed: true });
        });

        it('refuses to grant the report path to request_scope, since it is already writable without one', async () => {
            const g = guard([]);
            const decision = await g.grant(REPORT_RESULT_PATH);
            expect(decision).toMatchObject({ allowed: false, path: REPORT_RESULT_PATH });
            expect((decision as { reason: string }).reason).toContain('already writable without a grant');
            expect(g.grants()).toEqual([]);
        });

        it('leaves check() unaffected by a refused grant of the report path — it was already allowed', async () => {
            const g = guard([]);
            await g.grant(REPORT_RESULT_PATH);
            await expect(g.check(REPORT_RESULT_PATH)).resolves.toMatchObject({ allowed: true });
        });

        it('allows checkRead of the report path even when a project deny glob matches it, mirroring check()’s bypass', async () => {
            // The read side has to carry the same unconditional bypass as the write side: the
            // handler behind report_result reads this exact path back after writing it, through
            // checkRead — not check() — so a project deny glob that happens to match it (e.g. one
            // denying dotfiles) must not be able to refuse that read even though check() always
            // allows the write. Without the bypass this leaves result reporting permanently broken
            // for such a project, since grant() also refuses to widen the name.
            await expect(guard(['**'], [], ['.*']).checkRead(REPORT_RESULT_PATH)).resolves.toMatchObject({
                allowed: true,
                path: REPORT_RESULT_PATH,
            });
        });
    });

    describe('the scratch directory (card 0181)', () => {
        // A stage can generate throwaway output — a report to read, a probe script's output — that
        // an acceptance criterion needs produced and inspected without shipping it. `implementing`
        // can write but not delete; `review` is `readonly` and cannot write at all. SCRATCH_PREFIX is
        // the allow-side mirror of REPORT_RESULT_PATH for that case: a directory, not a single fixed
        // name, since a stage may need more than one scratch file.
        const scratchPath = `${SCRATCH_PREFIX}probe.json`;
        const nestedScratchPath = `${SCRATCH_PREFIX}sub/deeper.json`;

        it('allows a write under the scratch prefix even though no scope glob covers it', async () => {
            await expect(guard([]).check(scratchPath)).resolves.toMatchObject({ allowed: true, path: scratchPath, via: 'scope' });
        });

        it('allows a nested path several directories under the scratch prefix', async () => {
            await expect(guard([]).check(nestedScratchPath)).resolves.toMatchObject({ allowed: true, path: nestedScratchPath });
        });

        it('allows the scratch prefix even where the deny list would otherwise be checked first', async () => {
            await expect(guard(['**']).check(scratchPath)).resolves.toMatchObject({ allowed: true });
        });

        it('refuses to grant a scratch path to request_scope, since it is already writable without one', async () => {
            const g = guard([]);
            const decision = await g.grant(scratchPath);
            expect(decision).toMatchObject({ allowed: false, path: scratchPath });
            expect((decision as { reason: string }).reason).toContain('already writable without a grant');
            expect(g.grants()).toEqual([]);
        });

        it('leaves check() unaffected by a refused grant of a scratch path — it was already allowed', async () => {
            const g = guard([]);
            await g.grant(scratchPath);
            await expect(g.check(scratchPath)).resolves.toMatchObject({ allowed: true });
        });

        it('still denies a path that merely shares the scratch prefix’s leading characters, not the prefix itself', async () => {
            // `.wilson-scratch-backup/file.json` must not slip through a bare string-prefix check
            // that SCRATCH_PREFIX itself (with its trailing slash) does not actually perform.
            const decoy = `${SCRATCH_PREFIX.replace(/\/$/, '')}-backup/file.json`;
            await expect(guard([]).check(decoy)).resolves.toMatchObject({ allowed: false });
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

        it('says request_scope cannot widen the deny list from checkRead() too', async () => {
            const decision = await guard(['**']).checkRead('.runner/state.json');
            expect(decision).toMatchObject({ allowed: false });
            expect((decision as { reason: string }).reason).toContain('request_scope cannot widen it');
        });
    });
});
