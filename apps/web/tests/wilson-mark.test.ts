// @vitest-environment jsdom
//
// Card 0172: `WilsonMark` (`components/brand/WilsonMark.tsx`) is new. Like `StateIcon`, its source
// SVGs (`brand/wilson-mark.svg`, `brand/wilson-mark-16.svg`) each carry one fixed `<mask>` id —
// `brand/README.md`'s own note says two inlined marks on one page must not collide on it. This
// card's Constraints require `useId()` to mint a fresh id per instance and a test proving it.
import { createElement } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { WilsonMark } from '#src/components/brand/WilsonMark.js';

afterEach(() => {
    cleanup();
});

function renderedIds(): string[] {
    return [...document.querySelectorAll('[id]')].map(element => element.id);
}

describe('WilsonMark', () => {
    it('mints unique DOM ids across two instances', () => {
        render(createElement('div', null, createElement(WilsonMark), createElement(WilsonMark)));

        const ids = renderedIds();
        expect(ids.length).toBeGreaterThan(0);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('switches to the hinted wilson-mark-16 geometry below 24px', () => {
        const { container: small } = render(createElement(WilsonMark, { size: 16 }));
        const { container: large } = render(createElement(WilsonMark, { size: 24 }));

        // The hinted variant's head uses 9-radius rounded rects; the primary mark's uses 6.
        expect(small.querySelector('rect[rx="9"]')).toBeTruthy();
        expect(large.querySelector('rect[rx="9"]')).toBeNull();
        expect(large.querySelector('rect[rx="6"]')).toBeTruthy();
    });
});
