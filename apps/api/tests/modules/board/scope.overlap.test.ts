import { describe, expect, it } from 'vitest';
import { scopeOverlap } from '#modules/board/scope.overlap.js';

// Card 0069: nothing warned when two cards' `Files in scope` collided. `scopeOverlap` is the pure
// function behind that warning — given two cards' scope patterns, it returns every pair that can
// match a common path. Pure and standalone, like `nextCard`'s tests, so these exercise it directly
// against plain string arrays rather than standing up a board or a CLI command.
describe('scopeOverlap', () => {
    it('returns nothing for two empty scopes', () => {
        expect(scopeOverlap([], [])).toEqual([]);
    });

    it('returns nothing when one side is empty, however broad the other is', () => {
        expect(scopeOverlap([], ['apps/api/**'])).toEqual([]);
    });

    it('matches two identical literal patterns', () => {
        expect(scopeOverlap(['apps/api/src/modules/jobs/jobs.module.ts'], ['apps/api/src/modules/jobs/jobs.module.ts'])).toEqual([
            { ours: 'apps/api/src/modules/jobs/jobs.module.ts', theirs: 'apps/api/src/modules/jobs/jobs.module.ts' },
        ]);
    });

    it('does not match two different literal paths', () => {
        expect(scopeOverlap(['apps/api/src/a.ts'], ['apps/api/src/b.ts'])).toEqual([]);
    });

    it('matches a literal path against a glob that would select it', () => {
        expect(scopeOverlap(['apps/api/src/modules/jobs/jobs.module.ts'], ['apps/api/src/modules/jobs/*.ts'])).toEqual([
            { ours: 'apps/api/src/modules/jobs/jobs.module.ts', theirs: 'apps/api/src/modules/jobs/*.ts' },
        ]);
    });

    it('does not match a literal path against a glob that could never select it', () => {
        expect(scopeOverlap(['apps/api/src/modules/jobs/jobs.module.ts'], ['apps/api/src/modules/jobs/*.md'])).toEqual([]);
    });

    // Two globs against each other have no exact answer without enumerating strings; scopeOverlap
    // falls back to comparing each pattern's required literal prefix and suffix.
    it('overlaps two same-segment globs that agree on both prefix and suffix', () => {
        // `*.ts` (empty prefix, `.ts` suffix) and `jobs.*` (`jobs.` prefix, empty suffix) impose no
        // conflicting requirement, so a string satisfying both — `jobs.ts` — could exist.
        expect(scopeOverlap(['apps/api/src/*.ts'], ['apps/api/src/jobs.*'])).toEqual([
            { ours: 'apps/api/src/*.ts', theirs: 'apps/api/src/jobs.*' },
        ]);
    });

    it('treats two same-segment globs with conflicting suffixes as disjoint', () => {
        // `*.ts` requires a `.ts` suffix, `*.md` requires `.md` — neither suffix is consistent with
        // the other, so no string can satisfy both.
        expect(scopeOverlap(['apps/api/src/*.ts'], ['apps/api/src/*.md'])).toEqual([]);
    });

    // `**` is special: a whole path segment matching zero or more segments, exactly as picomatch and
    // every card's plan treat it — so a directory glob overlaps a specific, narrower file beneath it,
    // even though the directory glob never spells that file out.
    it('overlaps a directory glob against a narrower path beneath it', () => {
        expect(scopeOverlap(['apps/api/src/modules/jobs/**'], ['apps/api/src/modules/jobs/jobs.module.ts'])).toEqual([
            { ours: 'apps/api/src/modules/jobs/**', theirs: 'apps/api/src/modules/jobs/jobs.module.ts' },
        ]);
    });

    it('overlaps a directory glob against a file several segments deeper still', () => {
        expect(scopeOverlap(['apps/api/**'], ['apps/api/src/modules/jobs/jobs.module.ts'])).toEqual([
            { ours: 'apps/api/**', theirs: 'apps/api/src/modules/jobs/jobs.module.ts' },
        ]);
    });

    it('does not overlap a directory glob against a path outside that directory', () => {
        expect(scopeOverlap(['apps/api/src/modules/jobs/**'], ['apps/web/src/modules/jobs/jobs.module.ts'])).toEqual([]);
    });

    it('does not overlap two entirely disjoint literal trees', () => {
        expect(scopeOverlap(['apps/web/src/a.ts', 'apps/web/src/b.ts'], ['apps/api/src/c.ts', 'packages/cli/d.ts'])).toEqual([]);
    });

    it('returns every crossing pair, not just the first, when several patterns on each side collide', () => {
        const a = ['apps/api/src/modules/jobs/jobs.module.ts', 'apps/api/src/modules/jobs/card.stage.job.ts'];
        const b = ['apps/api/src/modules/jobs/jobs.module.ts', 'apps/api/src/modules/jobs/card.stage.job.ts'];

        const overlaps = scopeOverlap(a, b);

        expect(overlaps).toHaveLength(2);
        expect(overlaps).toEqual(
            expect.arrayContaining([
                { ours: 'apps/api/src/modules/jobs/jobs.module.ts', theirs: 'apps/api/src/modules/jobs/jobs.module.ts' },
                { ours: 'apps/api/src/modules/jobs/card.stage.job.ts', theirs: 'apps/api/src/modules/jobs/card.stage.job.ts' },
            ]),
        );
    });

    // The motivating incident: card 0066 was poisoned because its scope collided with 0051's on two
    // files, and nothing said so. Reproduced here with each side's scope declared the way a plan
    // would actually write it — 0066 names the files directly, 0051 covers them with a directory
    // glob — and the overlap must surface both shared files, not just one.
    it('reproduces the real 0066/0051 collision, warning on both shared files', () => {
        const card0066Scope = ['apps/api/src/modules/jobs/jobs.module.ts', 'apps/api/src/modules/jobs/card.stage.job.ts'];
        const card0051Scope = ['apps/api/src/modules/jobs/**'];

        const overlaps = scopeOverlap(card0066Scope, card0051Scope);

        expect(overlaps).toHaveLength(2);
        const touched = overlaps.map(o => o.ours).sort();
        expect(touched).toEqual(['apps/api/src/modules/jobs/card.stage.job.ts', 'apps/api/src/modules/jobs/jobs.module.ts']);
    });
});
