// Card 0136 (see plan.md "A drag between columns cannot be asserted"): the shared piece of the
// harness that finally resolves a dnd-kit drop under jsdom. jsdom gives every element an all-zero
// `getBoundingClientRect` (points 1-2 of the plan), so `rectIntersection` can never tell one
// droppable apart from another. Card 0046's own attempt patched individual nodes with
// `Object.defineProperty` and still failed — because dnd-kit does not measure only the droppable
// element. Instrumenting `Element.prototype.getBoundingClientRect` during a real drag (this card's
// task 2) shows it walks up from the dragged node through every scrollable ancestor and reads the
// droppable's own rect too, so a stub that only covers the droppable leaves the rest at zero and
// `rectIntersection` still finds nothing.
//
// The fix is a single prototype-level override (plan point 3 already showed this works in
// isolation) driven by a small ordered list of rules, `{ matches, rect }`, tried top to bottom for
// every element in the tree — not a per-node `defineProperty` on whatever a query helper happened
// to return. The first rule whose `matches` predicate accepts the element wins; an element no rule
// claims falls back to jsdom's real (zero) rect, which is correct for the vast majority of the tree
// dnd-kit never looks at.
export interface RectRule {
    /** Human-readable label, surfaced only in the "no rule matched" trace below. */
    readonly label: string;
    readonly matches: (el: Element) => boolean;
    readonly rect: DOMRectInit;
}

const toDOMRect = (init: DOMRectInit): DOMRect => ({
    x: init.x ?? 0,
    y: init.y ?? 0,
    width: init.width ?? 0,
    height: init.height ?? 0,
    top: init.y ?? 0,
    left: init.x ?? 0,
    right: (init.x ?? 0) + (init.width ?? 0),
    bottom: (init.y ?? 0) + (init.height ?? 0),
    toJSON() {
        return this;
    },
});

/**
 * Installs the prototype-level override for the lifetime of the callback, then restores the real
 * implementation — so a test that does not need stubbed geometry (or a later test in the same
 * file) is never affected by one that does. `fn` may be async (driving a keyboard drag needs a
 * real tick past dnd-kit's own `setTimeout(0)` — see `board.drag.test.ts`'s `dragRight`) — the
 * stub stays installed until whatever `fn` returns actually settles, not just until it is called.
 */
export async function withStubbedRects<T>(rules: readonly RectRule[], fn: () => T | Promise<T>): Promise<T> {
    const real = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function stubbed(this: Element) {
        for (const rule of rules) {
            if (rule.matches(this)) return toDOMRect(rule.rect);
        }
        return real.call(this);
    };
    try {
        return await fn();
    } finally {
        Element.prototype.getBoundingClientRect = real;
    }
}

/** A rule matching any element carrying one exact CSS class — the common case below. */
export const byClass = (label: string, className: string, rect: DOMRectInit): RectRule => ({
    label,
    matches: el => el.classList.contains(className),
    rect,
});

/** A rule matching one specific element instance, found ahead of time (e.g. by `data-testid`). */
export const byElement = (label: string, el: Element | null, rect: DOMRectInit): RectRule => ({
    label,
    matches: candidate => candidate === el,
    rect,
});

/** A rule matching a `data-testid` attribute — the test-only hooks `dragBoard.ts` renders. */
export const byTestId = (testId: string, rect: DOMRectInit): RectRule => ({
    label: `[data-testid="${testId}"]`,
    matches: el => el.getAttribute('data-testid') === testId,
    rect,
});
