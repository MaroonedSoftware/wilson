// @vitest-environment jsdom
//
// Card 0172: `src/theme.ts` is new. `main.tsx` wires it into `MantineProvider`'s `theme` prop, but
// `main.tsx` itself is never imported directly here — it renders to a real `#root` as a module-level
// side effect, the same reason no other test in this suite imports it. Instead this renders
// `MantineProvider` with the same `theme` object `main.tsx` passes and inspects the CSS variables it
// injects (`MantineCssVariables`, `@mantine/core`'s own mechanism for turning a theme into `:root`
// custom properties) — proof the values in `theme.ts` actually reach the provider, not just that
// `theme.ts` exports an object shaped the right way.
import { createElement } from 'react';
import { cleanup, render } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { theme } from '#src/theme.js';

beforeEach(() => {
    // jsdom does not implement matchMedia; MantineProvider reads it (colour-scheme detection) on
    // mount regardless of what this test renders — the same stub every other test in this suite uses.
    vi.stubGlobal(
        'matchMedia',
        vi.fn().mockImplementation((query: string) => ({
            matches: false,
            media: query,
            onchange: null,
            addListener: vi.fn(),
            removeListener: vi.fn(),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            dispatchEvent: vi.fn(),
        })),
    );
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

/** The `<style data-mantine-styles>` tag `MantineCssVariables` injects — its text is the theme's
 * values turned into `--mantine-*` custom properties, deduplicated against Mantine's own defaults. A
 * value this card's `theme.ts` deliberately overrides (unlike a value left at its default) always
 * survives that deduplication, which is exactly what each assertion below depends on. */
function renderedCssVariables(): string {
    render(createElement(MantineProvider, { theme }));
    return document.querySelector('style[data-mantine-styles]')?.textContent ?? '';
}

describe('theme.ts wired into MantineProvider', () => {
    it('sets primaryColor to "dark" — the monochrome default brand/README.md calls for', () => {
        expect(renderedCssVariables()).toMatch(/--mantine-primary-color-filled:\s*var\(--mantine-color-dark-filled\)/);
    });

    it('gives headings a serif stack for the wordmark feel, not Mantine\'s default sans', () => {
        const match = renderedCssVariables().match(/--mantine-font-family-headings:\s*([^;]*);/);
        expect(match?.[1]).toMatch(/serif/);
    });

    it('sets a monospace stack for code-like text (mono lowercase "wilson" beside commands)', () => {
        const match = renderedCssVariables().match(/--mantine-font-family-monospace:\s*([^;]*);/);
        expect(match?.[1]).toMatch(/mono/i);
    });
});
