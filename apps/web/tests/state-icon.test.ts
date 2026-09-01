// @vitest-environment jsdom
//
// Card 0172: `StateIcon` (`components/brand/StateIcon.tsx`) is new. Its source SVGs
// (`brand/states/*.svg`) each carry one fixed `<mask>` id per state (`wilson-parked`,
// `wilson-running`, …) — meant to be unique on the page (`brand/README.md`'s own note). Two
// instances of the *same* state rendered verbatim would collide on that id, and one would silently
// pick up the other's face. This card's Constraints require `useId()` to mint a fresh id per
// instance instead, and require a test proving it — this is that test.
import { createElement } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { StateIcon, type CardState } from '#src/components/brand/StateIcon.js';

afterEach(() => {
    cleanup();
});

/** Every `id` attribute in the rendered DOM, in document order. */
function renderedIds(): string[] {
    return [...document.querySelectorAll('[id]')].map(element => element.id);
}

describe('StateIcon', () => {
    it('mints unique DOM ids for two instances of the same state', () => {
        render(
            createElement('div', null, createElement(StateIcon, { state: 'passed' }), createElement(StateIcon, { state: 'passed' })),
        );

        const ids = renderedIds();
        expect(ids.length).toBeGreaterThan(0);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('mints unique ids across every state rendered together, not just one', () => {
        const states: CardState[] = ['parked', 'running', 'passed', 'kicked-back', 'needs-human', 'poisoned'];

        render(createElement('div', null, ...states.map(state => createElement(StateIcon, { state, key: state }))));

        const ids = renderedIds();
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('gives each state its own accessible name, matching brand/states/*.svg\'s own <title>', () => {
        render(createElement(StateIcon, { state: 'needs-human' }));

        expect(document.querySelector('svg')?.getAttribute('aria-labelledby')).toBeTruthy();
        expect(document.body.textContent).toContain('Wilson — needs human');
    });
});
