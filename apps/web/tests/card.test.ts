import { describe, expect, it } from 'vitest';
import { acceptanceCriteria, CARD_BODY_SKELETON, filesInScope, formatTimestamp } from '#src/lib/card.js';

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

/**
 * Card 0245. The web's own deliberate copy of 0236's `acceptanceCriteria` parser
 * (`apps/api/src/modules/board/card.ts`) — the same pattern `filesInScope` above already follows.
 * Same ID rule, same bullet stripping; these cases mirror the API parser's own tests
 * (`apps/api/tests/modules/board/acceptance.criteria.test.ts`) one-for-one so the two copies stay
 * pinned to the same behaviour.
 */
describe('acceptanceCriteria', () => {
    it('returns an empty list when the section is missing', () => {
        expect(acceptanceCriteria(undefined)).toEqual([]);
    });

    it('returns an empty list for an empty or blank section', () => {
        expect(acceptanceCriteria('')).toEqual([]);
        expect(acceptanceCriteria('   \n  \n')).toEqual([]);
    });

    it('assigns positional AC<n> IDs to bullets with no explicit label', () => {
        expect(acceptanceCriteria('- Widget renders.\n- Widget updates.')).toEqual([
            { id: 'AC1', text: 'Widget renders.' },
            { id: 'AC2', text: 'Widget updates.' },
        ]);
    });

    it('reads an explicit AC1: label as the ID and strips it from the text', () => {
        expect(acceptanceCriteria('- AC1: Widget renders.')).toEqual([{ id: 'AC1', text: 'Widget renders.' }]);
    });

    it('accepts AC-1: and AC1. as the same ID form, normalized to AC<n>', () => {
        expect(acceptanceCriteria('- AC-1: Widget renders.\n- AC2. Widget updates.')).toEqual([
            { id: 'AC1', text: 'Widget renders.' },
            { id: 'AC2', text: 'Widget updates.' },
        ]);
    });

    it('strips bullet markers and inline-code backticks before assigning IDs', () => {
        expect(acceptanceCriteria('* `AC1:` uses `lib/card.ts`.')).toEqual([{ id: 'AC1', text: 'uses lib/card.ts.' }]);
    });

    it('drops blank lines and HTML comment lines, like filesInScope does', () => {
        expect(acceptanceCriteria('- AC1: first.\n\n<!-- note -->\n- AC2: second.')).toEqual([
            { id: 'AC1', text: 'first.' },
            { id: 'AC2', text: 'second.' },
        ]);
    });

    it("does not fold an explicit label into the following positional bullet's numbering", () => {
        // A mixed plan: one bullet explicitly labelled AC1, the next left positional. The positional
        // bullet is the second bullet in the section, so it gets AC2 from its own order — not from
        // continuing after whatever number the explicit label used.
        expect(acceptanceCriteria('- AC1: first.\n- second, unlabelled.')).toEqual([
            { id: 'AC1', text: 'first.' },
            { id: 'AC2', text: 'second, unlabelled.' },
        ]);
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
