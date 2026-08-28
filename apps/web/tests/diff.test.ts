// Card 0138's `lib/diff.ts` is new: a minimal line-level, LCS-based diff with no context lines,
// copied from the terminal's `plan.command.ts` (see this card's Constraints) so `DraftPane.tsx` has
// something to render its approval diff from. This file covers `diffLines` directly, in isolation
// from the component that renders it (draft-pane.test.ts covers that).
import { describe, expect, it } from 'vitest';
import { diffLines } from '#src/lib/diff.js';

describe('diffLines', () => {
    it('returns nothing for two identical texts', () => {
        expect(diffLines('same\ntext', 'same\ntext')).toEqual([]);
    });

    it('reports every line of the after text as added when the before text is empty', () => {
        // `''.split('\n')` is `['']`, one (empty) line, not zero — so an empty before text still
        // contributes one `remove` of `''` alongside the genuine additions. Documenting the actual
        // behaviour `DraftPane.tsx` renders, not an idealised one.
        expect(diffLines('', 'one\ntwo')).toEqual([
            { kind: 'remove', text: '' },
            { kind: 'add', text: 'one' },
            { kind: 'add', text: 'two' },
        ]);
    });

    it('reports every line of the before text as removed when the after text is empty', () => {
        expect(diffLines('one\ntwo', '')).toEqual([
            { kind: 'remove', text: 'one' },
            { kind: 'remove', text: 'two' },
            { kind: 'add', text: '' },
        ]);
    });

    it('reports only the changed line for a single-line edit, not the whole file', () => {
        const changes = diffLines('line one\nline two\nline three', 'line one\nline TWO\nline three');

        expect(changes).toEqual([
            { kind: 'remove', text: 'line two' },
            { kind: 'add', text: 'line TWO' },
        ]);
    });

    it('reports an inserted line in the middle as a lone addition, with nothing around it flagged', () => {
        const changes = diffLines('a\nc', 'a\nb\nc');

        expect(changes).toEqual([{ kind: 'add', text: 'b' }]);
    });

    it('reports a deleted line in the middle as a lone removal', () => {
        const changes = diffLines('a\nb\nc', 'a\nc');

        expect(changes).toEqual([{ kind: 'remove', text: 'b' }]);
    });

    it('keeps removals and additions in their document order across multiple separate hunks', () => {
        const before = 'keep1\nold1\nkeep2\nold2\nkeep3';
        const after = 'keep1\nnew1\nkeep2\nnew2\nkeep3';

        expect(diffLines(before, after)).toEqual([
            { kind: 'remove', text: 'old1' },
            { kind: 'add', text: 'new1' },
            { kind: 'remove', text: 'old2' },
            { kind: 'add', text: 'new2' },
        ]);
    });
});
