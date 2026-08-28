import { describe, expect, it } from 'vitest';
import { captureAnchor, locateAnchor } from '#src/lib/anchor.js';

/**
 * `captureAnchor`/`locateAnchor` (card 0145) are the pure quote-anchoring module: capture a quote
 * plus its surrounding window from a document, then find that quote again in a possibly-rewritten
 * version of the document — reporting `outdated` rather than guessing when it can't be found. These
 * tests exercise the search behaviour directly against two plain strings, the way the plan itself
 * insists the module must be testable.
 */
describe('captureAnchor', () => {
    it('captures the quote and up to the window length of surrounding text', () => {
        const text = 'The quick brown fox jumps over the lazy dog near the old wooden fence today.';
        const start = text.indexOf('jumps over');
        const end = start + 'jumps over'.length;

        const anchor = captureAnchor(text, start, end);

        expect(anchor.quote).toBe('jumps over');
        expect(anchor.prefix).toBe(text.slice(Math.max(0, start - 60), start));
        expect(anchor.suffix).toBe(text.slice(end, end + 60));
        expect(anchor.prefix.endsWith('The quick brown fox ')).toBe(true);
        expect(anchor.suffix.startsWith(' the lazy dog')).toBe(true);
    });

    it('truncates the prefix at the start of the document instead of going negative', () => {
        const text = 'Short lead-in, then the quoted part, then a tail.';
        const start = 0;
        const end = 'Short'.length;

        const anchor = captureAnchor(text, start, end);

        expect(anchor.quote).toBe('Short');
        expect(anchor.prefix).toBe('');
    });

    it('truncates the suffix at the end of the document', () => {
        const text = 'Lead-in text and then the ending';
        const end = text.length;
        const start = text.indexOf('the ending');

        const anchor = captureAnchor(text, start, end);

        expect(anchor.quote).toBe('the ending');
        expect(anchor.suffix).toBe('');
    });

    it('returns plain strings, not a position: the captured anchor carries no offsets', () => {
        const text = 'Anchors are quote-based, not offsets, per PROJECT.md.';
        const anchor = captureAnchor(text, 10, 20);

        expect(Object.keys(anchor).sort()).toEqual(['prefix', 'quote', 'suffix']);
        expect('start' in anchor).toBe(false);
        expect('end' in anchor).toBe(false);
        expect('offset' in anchor).toBe(false);
    });
});

describe('locateAnchor', () => {
    it('finds an anchor captured from a document, at the same range, in that same document', () => {
        const text = 'Comments should anchor to a passage of the draft, not to a line number.';
        const start = text.indexOf('anchor to a passage');
        const end = start + 'anchor to a passage'.length;
        const anchor = captureAnchor(text, start, end);

        const result = locateAnchor(text, anchor);

        expect(result).toEqual({ status: 'found', range: { start, end } });
    });

    it('still finds a unique quote after its surrounding text was completely reworded', () => {
        const original = 'Before the meeting, review the quarterly budget figures carefully.';
        const start = original.indexOf('the quarterly budget figures');
        const end = start + 'the quarterly budget figures'.length;
        const anchor = captureAnchor(original, start, end);

        const rewritten = 'Prior to convening, please double-check the quarterly budget figures once more.';
        const newStart = rewritten.indexOf('the quarterly budget figures');

        const result = locateAnchor(rewritten, anchor);

        expect(result).toEqual({
            status: 'found',
            range: { start: newStart, end: newStart + 'the quarterly budget figures'.length },
        });
    });

    it('picks the occurrence whose window matches when the quote appears twice, not the first one', () => {
        const original = 'In the north wing, the meeting starts at noon. In the south wing, the meeting starts at noon.';
        const quote = 'the meeting starts at noon';
        const firstStart = original.indexOf(quote);
        const secondStart = original.indexOf(quote, firstStart + 1);
        expect(firstStart).not.toBe(secondStart);

        const anchor = captureAnchor(original, secondStart, secondStart + quote.length);
        expect(anchor.prefix.endsWith('In the south wing, ')).toBe(true);

        // Same document, unchanged — the quote still occurs twice; the anchor must resolve to the
        // *second* occurrence (the one whose window it was captured from), not the first.
        const result = locateAnchor(original, anchor);

        expect(result).toEqual({ status: 'found', range: { start: secondStart, end: secondStart + quote.length } });
        expect(result.status === 'found' && result.range.start).not.toBe(firstStart);
    });

    it('reports outdated when the quote no longer appears anywhere', () => {
        const original = 'The launch date is set for next Tuesday.';
        const start = original.indexOf('next Tuesday');
        const end = start + 'next Tuesday'.length;
        const anchor = captureAnchor(original, start, end);

        const rewritten = 'The launch date has not been decided yet.';

        const result = locateAnchor(rewritten, anchor);

        expect(result).toEqual({ status: 'outdated' });
    });

    it('reports outdated, rather than guessing, when two occurrences tie on window match', () => {
        // Both occurrences of "hello" sit in an identical surrounding sentence, so neither prefix
        // nor suffix can tell them apart — there is no textual basis to prefer one.
        const text = 'say hello world today. say hello world today.';
        const anchor = { quote: 'hello', prefix: 'say ', suffix: ' world' };

        const result = locateAnchor(text, anchor);

        expect(result).toEqual({ status: 'outdated' });
    });

    it('reports outdated for an anchor whose quote was itself edited, even amid similar text', () => {
        const original = 'The contract must be signed by Friday at the latest.';
        const start = original.indexOf('signed by Friday');
        const end = start + 'signed by Friday'.length;
        const anchor = captureAnchor(original, start, end);

        const rewritten = 'The contract must be signed by Monday at the latest.';

        const result = locateAnchor(rewritten, anchor);

        expect(result).toEqual({ status: 'outdated' });
    });

    it('never accepts an offset as an anchor: locateAnchor only reads quote/prefix/suffix', () => {
        const text = 'Some plain document text used only for this shape check.';
        // An anchor-shaped object with an offset bolted on must be ignored entirely by locateAnchor —
        // the extra field must not change the result relative to the same anchor without it.
        const anchor = { quote: 'document text', prefix: 'Some plain ', suffix: ' used only' };
        const anchorWithOffset = { ...anchor, offset: 5 } as typeof anchor & { offset: number };

        expect(locateAnchor(text, anchorWithOffset)).toEqual(locateAnchor(text, anchor));
    });
});
