/**
 * Mapping between plain-text character offsets — the same offsets `captureAnchor`/`locateAnchor`
 * (`lib/anchor.ts`) take and return — and real positions in the rendered DOM.
 *
 * This is the hand-written half of card [[0147]]'s Constraints: capturing where a person selected
 * in the rendered draft, and finding where a located anchor's range now sits so it can be
 * highlighted, are both browser `Selection`/`Range` API work with no Mantine equivalent. Nothing
 * here decides *whether* a passage is still there — that stays `locateAnchor`'s job alone; this
 * module only ever translates its offsets to and from on-screen positions.
 */

/**
 * The plain text a `container` should be treated as containing, for every offset below — the
 * same string `locateAnchor`/`captureAnchor` are given, and the string every other function here
 * measures its offsets against.
 */
export function containerText(container: HTMLElement): string {
    return container.textContent ?? '';
}

/** Character offset, into `containerText(container)`, of the point `node`/`nodeOffset` — a
 * `Range` boundary or a `Selection` endpoint. Measured by stringifying a `Range` run from the
 * start of `container` up to that point, so this agrees with `containerText` on what counts as a
 * character without a second, hand-rolled walk that would have to match it exactly. */
function offsetOfPoint(container: HTMLElement, node: Node, nodeOffset: number): number {
    const range = document.createRange();
    range.selectNodeContents(container);
    range.setEnd(node, nodeOffset);
    return range.toString().length;
}

/**
 * The current selection, as an offset span into `containerText(container)` — or `null` if there
 * is no selection, it is collapsed (a click, not a drag), or it reaches outside `container`
 * entirely. Never returns a reversed span: dragging from end to start yields the same
 * `{ start, end }` as dragging the other way.
 */
export function selectionOffsets(container: HTMLElement, selection: Selection): { start: number; end: number } | null {
    if (selection.isCollapsed || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    if (!container.contains(range.commonAncestorContainer)) return null;

    const a = offsetOfPoint(container, range.startContainer, range.startOffset);
    const b = offsetOfPoint(container, range.endContainer, range.endOffset);
    if (a === b) return null;
    return a < b ? { start: a, end: b } : { start: b, end: a };
}

/** The text node and inner offset that sit `offset` characters into `container`'s text nodes, in
 * document order — the inverse of `offsetOfPoint`. `null` once `offset` runs past the end of the
 * container's own text. */
function pointAtOffset(container: HTMLElement, offset: number): { node: Text; offset: number } | null {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let remaining = offset;
    let node = walker.nextNode() as Text | null;
    while (node) {
        const length = node.data.length;
        if (remaining <= length) return { node, offset: remaining };
        remaining -= length;
        node = walker.nextNode() as Text | null;
    }
    return null;
}

/**
 * A `Range` covering `[start, end)` of `containerText(container)` — for turning a located
 * anchor's range, or a fresh selection, back into something the DOM can point at (a highlight's
 * `getClientRects()`, a popover's target). `null` if either offset falls outside the container's
 * actual text, which only happens when `container` no longer holds the text the offsets were
 * computed against.
 */
export function rangeForOffsets(container: HTMLElement, start: number, end: number): Range | null {
    const startPoint = pointAtOffset(container, start);
    const endPoint = pointAtOffset(container, end);
    if (!startPoint || !endPoint) return null;
    const range = document.createRange();
    range.setStart(startPoint.node, startPoint.offset);
    range.setEnd(endPoint.node, endPoint.offset);
    return range;
}
