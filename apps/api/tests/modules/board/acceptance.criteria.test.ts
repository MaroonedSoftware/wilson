import { describe, expect, it } from 'vitest';
import { acceptanceCriteria } from '#modules/board/card.js';
import type { Card } from '#modules/board/card.js';

/**
 * Card 0236: every acceptance criterion gets a stable ID — an explicit `AC1:`/`AC-1:`/`AC1.` token
 * on the bullet, normalized to `AC<n>`, or a positional `AC<n>` from the bullet's order in the
 * section when it carries no token of its own. `ReviewVerifier` (`review.verifier.test.ts`) is what
 * actually exercises this against a review result; this file drives `acceptanceCriteria` directly,
 * the same way `board-view.test.ts` drives the CLI's own copy of `filesInScope` — the sibling
 * function this one was modelled on, sharing its bullet-stripping rules.
 */
const card = (raw: string | undefined): Card => ({
    frontmatter: { id: '0001', title: 'thing', stage: 'planning', dependsOn: [], retries: {} },
    sections: raw === undefined ? {} : { 'Acceptance criteria': raw },
    body: '',
});

describe('acceptanceCriteria', () => {
    it('returns nothing when the section is absent', () => {
        expect(acceptanceCriteria(card(undefined))).toEqual([]);
    });

    it('returns nothing when the section is present but empty', () => {
        expect(acceptanceCriteria(card(''))).toEqual([]);
    });

    it('assigns positional AC<n> ids, in order, to bullets with no ID token', () => {
        const result = acceptanceCriteria(card('- does the first thing\n- does the second thing'));

        expect(result).toEqual([
            { id: 'AC1', text: 'does the first thing' },
            { id: 'AC2', text: 'does the second thing' },
        ]);
    });

    it('reads an explicit "AC1:" token as the ID, stripping it from the text', () => {
        const result = acceptanceCriteria(card('- AC1: does the thing'));

        expect(result).toEqual([{ id: 'AC1', text: 'does the thing' }]);
    });

    it('normalizes an "AC-1:" token to "AC1"', () => {
        const result = acceptanceCriteria(card('- AC-1: does the thing'));

        expect(result).toEqual([{ id: 'AC1', text: 'does the thing' }]);
    });

    it('reads an "AC1." token (dot, not colon) the same way', () => {
        const result = acceptanceCriteria(card('- AC1. does the thing'));

        expect(result).toEqual([{ id: 'AC1', text: 'does the thing' }]);
    });

    it('preserves each bullet’s own explicit ID, even out of numeric order', () => {
        const result = acceptanceCriteria(card('- AC3: does the third thing\n- AC1: does the first thing'));

        expect(result).toEqual([
            { id: 'AC3', text: 'does the third thing' },
            { id: 'AC1', text: 'does the first thing' },
        ]);
    });

    // A bullet with no token gets its ID from its own position among the section's bullets — not
    // from the highest explicit number seen so far. Card 0236's stated rule is purely positional, so
    // an unlabelled bullet after an "AC5:" one gets "AC2" (its position), not "AC6".
    it('gives an unlabelled bullet its positional ID, not one continuing after a neighboring explicit ID', () => {
        const result = acceptanceCriteria(card('- AC5: an explicitly numbered one\n- an unlabelled one'));

        expect(result).toEqual([
            { id: 'AC5', text: 'an explicitly numbered one' },
            { id: 'AC2', text: 'an unlabelled one' },
        ]);
    });

    it('ignores blank lines and an HTML-comment placeholder line', () => {
        const result = acceptanceCriteria(card('- AC1: does the thing\n\n<!-- nothing else -->\n'));

        expect(result).toEqual([{ id: 'AC1', text: 'does the thing' }]);
    });

    it('parses -, * and + bullet markers alike', () => {
        const result = acceptanceCriteria(card('- AC1: one\n* AC2: two\n+ AC3: three'));

        expect(result.map(c => c.id)).toEqual(['AC1', 'AC2', 'AC3']);
    });

    it('strips inline code backticks from the bullet before matching the ID token', () => {
        const result = acceptanceCriteria(card('- `AC1: does the thing`'));

        expect(result).toEqual([{ id: 'AC1', text: 'does the thing' }]);
    });

    it('trims surrounding whitespace on the extracted text', () => {
        const result = acceptanceCriteria(card('-   AC1:   does the thing   '));

        expect(result).toEqual([{ id: 'AC1', text: 'does the thing' }]);
    });
});
