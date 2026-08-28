// @vitest-environment jsdom
//
// Card 0147's `lib/textPosition.ts` is new: the hand-written half of this card's Constraints —
// mapping plain-text character offsets (the same offsets `captureAnchor`/`locateAnchor`,
// `lib/anchor.ts`, take and return) to and from real positions in the rendered DOM. This file
// covers each exported function directly, against plain DOM nodes with no React and no
// `CommentableDraft` involved, so a bug in the offset math itself is caught independently of
// anything downstream that composes it.
import { afterEach, describe, expect, it } from 'vitest';
import { containerText, rangeForOffsets, selectionOffsets } from '#src/lib/textPosition.js';

function makeContainer(html: string): HTMLDivElement {
    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.appendChild(container);
    return container;
}

afterEach(() => {
    window.getSelection()?.removeAllRanges();
    document.body.innerHTML = '';
});

describe('containerText', () => {
    it("is the container's own textContent — inline formatting contributes no extra characters", () => {
        const container = makeContainer('<p>hello <strong>world</strong></p>');
        expect(containerText(container)).toBe('hello world');
    });

    it('returns an empty string for an empty container rather than throwing', () => {
        const container = makeContainer('');
        expect(containerText(container)).toBe('');
    });
});

describe('rangeForOffsets', () => {
    it('returns a Range whose text is exactly the requested span, across an element boundary', () => {
        const container = makeContainer('<p>hello <strong>world</strong> today</p>');

        const range = rangeForOffsets(container, 6, 11);

        expect(range?.toString()).toBe('world');
    });

    it('returns a Range starting mid-word just as well as one starting on a word boundary', () => {
        const container = makeContainer('<p>hello world</p>');

        const range = rangeForOffsets(container, 2, 8);

        expect(range?.toString()).toBe('llo wo');
    });

    it('returns null once the end offset runs past the container\'s own text', () => {
        const container = makeContainer('<p>short</p>');

        expect(rangeForOffsets(container, 0, 999)).toBeNull();
    });

    it('returns null once the start offset runs past the container\'s own text', () => {
        const container = makeContainer('<p>short</p>');

        expect(rangeForOffsets(container, 999, 1000)).toBeNull();
    });
});

describe('selectionOffsets', () => {
    it('returns the offsets of a forward selection made within the container', () => {
        const container = makeContainer('<p>hello world</p>');
        const textNode = container.querySelector('p')!.firstChild!;
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.setBaseAndExtent(textNode, 0, textNode, 5);

        expect(selectionOffsets(container, selection)).toEqual({ start: 0, end: 5 });
    });

    it('normalizes a backward drag to the very same {start, end} the forward drag over the same text yields', () => {
        const container = makeContainer('<p>hello world</p>');
        const textNode = container.querySelector('p')!.firstChild!;
        const selection = window.getSelection()!;

        // Dragged from "d" (offset 11) back to "w" (offset 6) — the reverse of the drag above.
        selection.removeAllRanges();
        selection.setBaseAndExtent(textNode, 11, textNode, 6);

        expect(selectionOffsets(container, selection)).toEqual({ start: 6, end: 11 });
    });

    it('returns null for a collapsed selection — a click, not a drag', () => {
        const container = makeContainer('<p>hello world</p>');
        const textNode = container.querySelector('p')!.firstChild!;
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.setBaseAndExtent(textNode, 3, textNode, 3);

        expect(selectionOffsets(container, selection)).toBeNull();
    });

    it('returns null when the selection reaches outside the given container entirely', () => {
        const outer = makeContainer('<div id="other">elsewhere</div><div id="target">hello world</div>');
        const other = outer.querySelector('#other')!.firstChild!;
        const target = outer.querySelector('#target') as HTMLElement;
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.setBaseAndExtent(other, 0, other, 4);

        expect(selectionOffsets(target, selection)).toBeNull();
    });

    it('round-trips with rangeForOffsets — locating the offsets it just captured selects the same text back', () => {
        const container = makeContainer('<p>The quick <em>brown fox</em> jumps</p>');
        const textNode = container.querySelector('em')!.firstChild!;
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.setBaseAndExtent(textNode, 0, textNode, 5); // "brown"

        const offsets = selectionOffsets(container, selection)!;
        expect(containerText(container).slice(offsets.start, offsets.end)).toBe('brown');
        expect(rangeForOffsets(container, offsets.start, offsets.end)?.toString()).toBe('brown');
    });
});
