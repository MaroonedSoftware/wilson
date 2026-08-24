import { describe, expect, it } from 'vitest';
import { filesInScope, formatTimestamp } from '#src/lib/card.js';

describe('filesInScope', () => {
    it('returns an empty list when the section is missing', () => {
        expect(filesInScope(undefined)).toEqual([]);
    });

    it('returns an empty list for an empty or blank section', () => {
        expect(filesInScope('')).toEqual([]);
        expect(filesInScope('   \n  \n')).toEqual([]);
    });

    it('strips bullet markers so the glob itself is what is shown', () => {
        expect(filesInScope('- apps/web/**\n* apps/api/**\n+ packages/sdk/**')).toEqual(['apps/web/**', 'apps/api/**', 'packages/sdk/**']);
    });

    it('strips inline-code backticks, which are formatting rather than part of the glob', () => {
        expect(filesInScope('- `apps/web/src/lib/card.ts`')).toEqual(['apps/web/src/lib/card.ts']);
    });

    it('trims surrounding whitespace on each line', () => {
        expect(filesInScope('  - apps/web/**  \n')).toEqual(['apps/web/**']);
    });

    it('drops blank lines between entries', () => {
        expect(filesInScope('- apps/web/**\n\n- apps/api/**')).toEqual(['apps/web/**', 'apps/api/**']);
    });

    it('drops HTML comment lines, which annotate the plan rather than list a file', () => {
        expect(filesInScope('- apps/web/**\n<!-- everything under web -->\n- apps/api/**')).toEqual(['apps/web/**', 'apps/api/**']);
    });

    it('preserves order and duplicates as written in the plan', () => {
        expect(filesInScope('- apps/web/**\n- apps/web/**')).toEqual(['apps/web/**', 'apps/web/**']);
    });
});

describe('formatTimestamp', () => {
    it('delegates to the platform locale formatting of the given instant', () => {
        const iso = '2026-01-15T10:30:00.000Z';
        expect(formatTimestamp(iso)).toBe(new Date(iso).toLocaleString());
    });

    it('produces different output for different instants', () => {
        expect(formatTimestamp('2026-01-15T10:30:00.000Z')).not.toBe(formatTimestamp('2020-06-01T00:00:00.000Z'));
    });
});
