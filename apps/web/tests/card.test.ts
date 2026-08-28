import { describe, expect, it } from 'vitest';
import { CARD_BODY_SKELETON, filesInScope, formatTimestamp } from '#src/lib/card.js';

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

describe('CARD_BODY_SKELETON', () => {
    // Card 0142: NewCardControl seeds its body Textarea from this constant so a card filed as a
    // plan starts in the same shape `wilson card create` seeds `$EDITOR` with
    // (`packages/cli/src/commands/card/create.command.ts`'s own `SKELETON`). Duplicated rather than
    // imported (`apps/web` does not depend on `packages/cli`), so this pins the two copies together
    // — a drift here is exactly the regression the plan's "seed the body" constraint forbids.
    const HEADINGS = ['Goal', 'Constraints', 'Files in scope', 'Tasks', 'Acceptance criteria', 'Out of scope'];

    it('carries all six of a plan\'s headings, in the order a plan reads them', () => {
        const headingLines = CARD_BODY_SKELETON.split('\n').filter(line => line.startsWith('## '));
        expect(headingLines).toEqual(HEADINGS.map(h => `## ${h}`));
    });

    it('leaves every heading empty — a seed to fill in, not placeholder prose', () => {
        const sections = CARD_BODY_SKELETON.split(/^## .+$/m).map(s => s.trim());
        // The first split chunk is whatever precedes the first heading (blank); every remaining
        // chunk is the body directly under one heading, and none of the six should carry text.
        expect(sections.slice(1).every(section => section.length === 0)).toBe(true);
    });

    it('matches create.command.ts\'s own SKELETON exactly, character for character', () => {
        const cliSkeleton = `
## Goal

## Constraints

## Files in scope

## Tasks

## Acceptance criteria

## Out of scope
`;
        expect(CARD_BODY_SKELETON).toBe(cliSkeleton);
    });
});
