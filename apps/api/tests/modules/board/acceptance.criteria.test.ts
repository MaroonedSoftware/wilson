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

    /*
     * Card 0268: a criterion whose text wraps across lines used to parse as one bullet per line,
     * each continuation line minting its own positional ID that could collide with a real one
     * (the bug behind cards 0265 and 0266's false-positive review failures). `splitBullets` now
     * folds a non-blank, markerless continuation onto the bullet above it. This fails on the
     * pre-change tree, which reads three separate criteria here instead of one.
     */
    it('AC1: folds a criterion wrapped over three lines into one, its text the lines joined with single spaces', () => {
        const result = acceptanceCriteria(card('- AC1: does the thing across\n  several lines that\n  all wrap'));

        expect(result).toEqual([{ id: 'AC1', text: 'does the thing across several lines that all wrap' }]);
    });

    // AC2: seven explicitly-numbered criteria, several wrapped, still parse as exactly seven —
    // every ID stays the explicit one on the bullet, not a positional count inflated by
    // continuation lines. Fails on the pre-change tree, which reads more than seven bullets here.
    it('AC2: parses seven explicitly numbered criteria as seven, whatever the wrapping, minting no positional id', () => {
        const raw = [
            '- AC1: first criterion that',
            '  wraps onto a second line',
            '- AC2: second criterion',
            '- AC3: third criterion that',
            '  also wraps here',
            '- AC4: fourth criterion',
            '- AC5: fifth criterion',
            '- AC6: sixth criterion',
            '- AC7: seventh criterion',
        ].join('\n');

        const result = acceptanceCriteria(card(raw));

        expect(result).toEqual([
            { id: 'AC1', text: 'first criterion that wraps onto a second line' },
            { id: 'AC2', text: 'second criterion' },
            { id: 'AC3', text: 'third criterion that also wraps here' },
            { id: 'AC4', text: 'fourth criterion' },
            { id: 'AC5', text: 'fifth criterion' },
            { id: 'AC6', text: 'sixth criterion' },
            { id: 'AC7', text: 'seventh criterion' },
        ]);
    });

    // AC3: a blank line always ends a bullet, even when what follows looks like it could continue
    // one — it starts a fresh bullet instead of joining the one before the gap. Fails on the
    // pre-change tree, which reads four criteria here (one per non-blank line) instead of two.
    it('AC3: never joins a bullet across a blank line, even when the next lines carry no marker of their own', () => {
        const raw = '- AC1: first bullet spans\n  two lines here\n\n  and this separate paragraph\n  should be its own item';

        const result = acceptanceCriteria(card(raw));

        expect(result).toEqual([
            { id: 'AC1', text: 'first bullet spans two lines here' },
            { id: 'AC2', text: 'and this separate paragraph should be its own item' },
        ]);
    });

    // AC3 (second half): a section with no bullet marker at all keeps one item per line — the
    // shape `Files in scope`'s bare-path lists rely on, and unchanged by this card.
    it('AC3: keeps one item per line when the section carries no bullet marker at all', () => {
        const result = acceptanceCriteria(card('first line, no marker\nsecond line, no marker'));

        expect(result).toEqual([
            { id: 'AC1', text: 'first line, no marker' },
            { id: 'AC2', text: 'second line, no marker' },
        ]);
    });
});
