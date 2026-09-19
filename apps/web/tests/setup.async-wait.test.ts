// @vitest-environment jsdom
//
// Card 0251: `apps/web/tests/setup.ts` raises Testing Library's `asyncUtilTimeout` to 5000ms so
// `findBy*`/`waitFor` survive a slow render under the full suite's load, instead of flaking the
// way `apps/web/tests/project-switcher.test.ts` did against card 0250's merge check on 2026-09-19
// (`await screen.findByText('0 cards')` timing out at the old 1000ms default even though the test
// waited correctly). `setup.test.ts` checks the configured number directly; this proves it holds
// for a real `findByText` wait against a component that is slow on purpose, and that a wait for
// text that never shows up still fails rather than hanging forever.
import { createElement, useEffect, useState } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

/** Renders nothing until `delayMs` after mount, then renders `text` — standing in for a route
 * whose data load plus query lands past Testing Library's old 1000ms default `findBy*` wait. */
function DelayedText({ text, delayMs }: { text: string; delayMs: number }) {
    const [visible, setVisible] = useState(false);
    useEffect(() => {
        const timer = setTimeout(() => setVisible(true), delayMs);
        return () => clearTimeout(timer);
    }, [text, delayMs]);
    return visible ? createElement('p', null, text) : null;
}

afterEach(() => {
    cleanup();
});

describe('findByText under the raised asyncUtilTimeout', () => {
    it('waits out a 2 second render, which the old 1000ms default could not', async () => {
        render(createElement(DelayedText, { text: 'ready', delayMs: 2000 }));

        expect(await screen.findByText('ready')).toBeTruthy();
    });

    it('still fails for text that never appears', async () => {
        render(createElement(DelayedText, { text: 'ready', delayMs: 60000 }));

        await expect(screen.findByText('ready')).rejects.toThrow();
    }, 8000);
});
