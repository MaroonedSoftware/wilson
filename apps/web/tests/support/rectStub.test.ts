// @vitest-environment jsdom
//
// Card 0136: unit coverage for `rectStub.ts` itself. `board.drag.test.ts` proves the stub works
// end to end through a real drag, but every assertion there is mediated by dnd-kit's own collision
// math — a bug in rule ordering, in the `byElement`/`byClass`/`byTestId` matchers, or in
// `toDOMRect`'s field defaulting could easily still leave `over` resolving to *something*, just not
// provably the right something for the right reason. These tests call `withStubbedRects` directly
// against plain DOM nodes, with no React, no dnd-kit and no Board involved, so each one isolates a
// single claim the module's own comments make.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { byClass, byElement, byTestId, withStubbedRects } from './rectStub.js';

describe('withStubbedRects', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('returns the stubbed rect, with left/top/right/bottom derived from x/y/width/height', async () => {
        const el = document.createElement('div');
        el.className = 'target';

        await withStubbedRects([byClass('target', 'target', { x: 10, y: 20, width: 100, height: 50 })], () => {
            const r = el.getBoundingClientRect();
            expect(r.x).toBe(10);
            expect(r.y).toBe(20);
            expect(r.left).toBe(10);
            expect(r.top).toBe(20);
            expect(r.width).toBe(100);
            expect(r.height).toBe(50);
            expect(r.right).toBe(110);
            expect(r.bottom).toBe(70);
        });
    });

    it('defaults unspecified rect fields to 0 rather than NaN', async () => {
        const el = document.createElement('div');
        el.className = 'partial';

        await withStubbedRects([byClass('partial', 'partial', { width: 40 })], () => {
            const r = el.getBoundingClientRect();
            expect(r.x).toBe(0);
            expect(r.y).toBe(0);
            expect(r.width).toBe(40);
            expect(r.height).toBe(0);
            expect(r.right).toBe(40);
            expect(r.bottom).toBe(0);
        });
    });

    it('toJSON returns the rect itself, matching the DOMRect contract', async () => {
        const el = document.createElement('div');
        el.className = 'jsontest';

        await withStubbedRects([byClass('jsontest', 'jsontest', { x: 1, y: 2, width: 3, height: 4 })], () => {
            const r = el.getBoundingClientRect();
            expect(r.toJSON()).toBe(r);
        });
    });

    it('tries rules in order and stops at the first match — later rules never override an earlier one', async () => {
        const el = document.createElement('div');
        el.className = 'a b';

        await withStubbedRects(
            [
                byClass('first rule, matches .a', 'a', { x: 1, y: 1, width: 1, height: 1 }),
                byClass('second rule, also matches .b on the same element', 'b', { x: 2, y: 2, width: 2, height: 2 }),
            ],
            () => {
                expect(el.getBoundingClientRect().x).toBe(1);
            },
        );
    });

    it('falls back to whatever the real implementation was for an element no rule matches', async () => {
        // A sentinel distinguishable from jsdom's own all-zero default, so the assertion below
        // proves the real implementation was actually *called through to*, not that it happened to
        // return the same zeroes a missing stub would.
        const sentinel = {
            x: 999,
            y: 999,
            width: 999,
            height: 999,
            top: 999,
            left: 999,
            right: 1998,
            bottom: 1998,
            toJSON() {
                return this;
            },
        } as DOMRect;
        const original = Element.prototype.getBoundingClientRect;
        Element.prototype.getBoundingClientRect = vi.fn(() => sentinel);
        try {
            const el = document.createElement('div');
            await withStubbedRects([byClass('does not match this element', 'does-not-exist', { x: 5, y: 5, width: 5, height: 5 })], () => {
                expect(el.getBoundingClientRect()).toBe(sentinel);
            });
        } finally {
            Element.prototype.getBoundingClientRect = original;
        }
    });

    it('restores the original implementation once fn resolves', async () => {
        const original = Element.prototype.getBoundingClientRect;

        await withStubbedRects([byClass('x', 'x', { x: 1, y: 1, width: 1, height: 1 })], () => {
            expect(Element.prototype.getBoundingClientRect).not.toBe(original);
        });

        expect(Element.prototype.getBoundingClientRect).toBe(original);
    });

    it('restores the original implementation even when fn throws, instead of leaking the stub into later tests', async () => {
        const original = Element.prototype.getBoundingClientRect;

        await expect(
            withStubbedRects([byClass('x', 'x', { x: 1, y: 1, width: 1, height: 1 })], () => {
                throw new Error('boom');
            }),
        ).rejects.toThrow('boom');

        expect(Element.prototype.getBoundingClientRect).toBe(original);
    });

    it('byElement matches only the exact instance, not other elements that share its class', async () => {
        const target = document.createElement('div');
        target.className = 'shared';
        const decoy = document.createElement('div');
        decoy.className = 'shared';

        await withStubbedRects([byElement('the target node', target, { x: 42, y: 0, width: 10, height: 10 })], () => {
            expect(target.getBoundingClientRect().x).toBe(42);
            // Falls through to jsdom's real (all-zero) rect — proving the rule keys off identity,
            // not off the class the two elements happen to share.
            expect(decoy.getBoundingClientRect().x).toBe(0);
        });
    });

    it('byTestId matches by the data-testid attribute, and only that attribute', async () => {
        const el = document.createElement('div');
        el.setAttribute('data-testid', 'my-node');
        const wrongId = document.createElement('div');
        wrongId.setAttribute('data-testid', 'other-node');

        await withStubbedRects([byTestId('my-node', { x: 7, y: 0, width: 0, height: 0 })], () => {
            expect(el.getBoundingClientRect().x).toBe(7);
            expect(wrongId.getBoundingClientRect().x).toBe(0);
        });
    });
});
