import { describe, expect, it } from 'vitest';
import { filesInScope } from '#modules/board/card.js';
import type { Card } from '#modules/board/card.js';

/**
 * Card 0268: `filesInScope` reads `Files in scope` through the same `splitBullets` now shared with
 * `acceptanceCriteria` (`acceptance.criteria.test.ts`) and `expectedSkippedTests`
 * (`expected.skipped.tests.test.ts`), so a bullet whose pattern wraps across lines folds onto one
 * item instead of minting an extra one per continuation line. Single-line bullets and the bare,
 * markerless path list this section is usually written as are unchanged.
 */
const card = (raw: string | undefined): Card => ({
    frontmatter: { id: '0001', title: 'thing', stage: 'planning', dependsOn: [], retries: {} },
    sections: raw === undefined ? {} : { 'Files in scope': raw },
    body: '',
});

describe('filesInScope', () => {
    it('AC4: returns nothing when the section is absent', () => {
        expect(filesInScope(card(undefined))).toEqual([]);
    });

    it('AC4: strips the bullet marker and inline code backticks from a single-line entry, unchanged', () => {
        expect(filesInScope(card('- `apps/api/src/modules/board/card.ts`'))).toEqual(['apps/api/src/modules/board/card.ts']);
    });

    it('AC4: keeps one pattern per line when the section carries no bullet marker at all', () => {
        const result = filesInScope(card('apps/api/src/a.ts\napps/api/src/b.ts'));

        expect(result).toEqual(['apps/api/src/a.ts', 'apps/api/src/b.ts']);
    });

    // Fails on the pre-change tree: the old line-per-bullet split reads the continuation line as
    // its own entry, so this returns two patterns instead of one joined by a space.
    it('AC4: folds a bullet whose pattern wraps onto a continuation line into one entry', () => {
        const raw = '- apps/api/src/modules/board/card.ts is described by prose\n  that continues on a second line';

        const result = filesInScope(card(raw));

        expect(result).toEqual(['apps/api/src/modules/board/card.ts is described by prose that continues on a second line']);
    });

    // AC3, applied to this section: a blank line still ends a bullet, even between two entries
    // that both carry markers.
    it('never joins two marked bullets separated by a blank line', () => {
        const result = filesInScope(card('- apps/api/src/a.ts\n\n- apps/api/src/b.ts'));

        expect(result).toEqual(['apps/api/src/a.ts', 'apps/api/src/b.ts']);
    });
});
