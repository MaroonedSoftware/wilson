import { describe, expect, it } from 'vitest';
import { completeSections, PLAN_SECTIONS, sectionsOf } from '#modules/board/card.js';

/** All `## ` headings in a body, in the order they appear. */
const headingsOf = (text: string): string[] => [...text.matchAll(/^## (.+)$/gm)].map(m => m[1]!);

const FULL_BODY = [
    '## Goal',
    'Ship the thing.',
    '',
    '## Constraints',
    'Keep it small.',
    '',
    '## Files in scope',
    '- src/thing.ts',
    '',
    '## Tasks',
    '1. Do it.',
    '',
    '## Acceptance criteria',
    '- It works.',
    '',
    '## Out of scope',
    'Nothing else.',
    '',
].join('\n');

describe('completeSections', () => {
    it('returns a body with all six headings unchanged, byte for byte', () => {
        expect(completeSections(FULL_BODY)).toBe(FULL_BODY);
    });

    it('appends the full skeleton, in PLAN_SECTIONS order, after prose that has none of the six headings', () => {
        const body = '## Note\n\nA thought captured mid-review, not a plan.\n';

        const result = completeSections(body);

        // Nothing from the card's own body is discarded.
        expect(result).toContain('## Note');
        expect(result).toContain('A thought captured mid-review, not a plan.');
        // Every one of the six is present, appended in PLAN_SECTIONS order.
        expect(headingsOf(result)).toEqual(['Note', ...PLAN_SECTIONS]);
    });

    it('keeps headings the body already has exactly where and how they were written, and appends only what is missing', () => {
        // Deliberately out of canonical order, and only two of the six.
        const body = ['## Out of scope', 'Nothing outside the API.', '', '## Goal', 'Ship the seed fix.', ''].join('\n');

        const result = completeSections(body);

        // The card's own two headings keep their own relative order — not normalised to
        // PLAN_SECTIONS order — and their own wording.
        expect(headingsOf(result).slice(0, 2)).toEqual(['Out of scope', 'Goal']);
        expect(result).toContain('Nothing outside the API.');
        expect(result).toContain('Ship the seed fix.');

        // Only the four missing headings were appended, in PLAN_SECTIONS order among themselves.
        const missing = PLAN_SECTIONS.filter(s => s !== 'Out of scope' && s !== 'Goal');
        expect(headingsOf(result).slice(2)).toEqual(missing);
    });

    it('leaves the appended headings empty — a section to be filled in, not pre-filled with anything', () => {
        const body = '## Goal\n\nDo the one thing.\n';

        const result = completeSections(body);
        const sections = sectionsOf(result);

        expect(sections['Goal']).toBe('Do the one thing.');
        for (const section of PLAN_SECTIONS) {
            if (section === 'Goal') continue;
            expect(sections[section]).toBe('');
        }
    });

    it('preserves a non-plan heading the card wrote, such as "## Note", rather than stripping it', () => {
        const body = '## Note\n\nfrom the parking lot\n\n## Goal\n\nDo the thing.\n';

        const result = completeSections(body);

        expect(result).toContain('## Note');
        expect(result).toContain('from the parking lot');
        // "Note" is not one of the six, so it is not counted as satisfying any of them — Goal is
        // still the only one present, and the other five are still appended.
        expect(headingsOf(result)).toEqual(['Note', 'Goal', 'Constraints', 'Files in scope', 'Tasks', 'Acceptance criteria', 'Out of scope']);
    });

    it('is a no-op for a body that is only whitespace-different from complete, but still appends when a heading is genuinely absent', () => {
        // Sanity check on the "complete" branch boundary: five of six is still incomplete.
        const missingOutOfScope = FULL_BODY.split('## Out of scope')[0]!;

        const result = completeSections(missingOutOfScope);

        expect(result).not.toBe(missingOutOfScope);
        expect(headingsOf(result)).toEqual(['Goal', 'Constraints', 'Files in scope', 'Tasks', 'Acceptance criteria', 'Out of scope']);
        expect(sectionsOf(result)['Out of scope']).toBe('');
    });
});
