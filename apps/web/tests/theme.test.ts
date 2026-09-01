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
import { theme, cssVariablesResolver } from '#src/theme.js';

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

/** Same as `renderedCssVariables`, but also wires `cssVariablesResolver` — the way `main.tsx` passes
 * it to `MantineProvider` — so scheme-scoped variables it sets (card 0179) show up in the output too. */
function renderedCssVariablesWithResolver(): string {
    render(createElement(MantineProvider, { theme, cssVariablesResolver }));
    return document.querySelector('style[data-mantine-styles]')?.textContent ?? '';
}

/** `convertCssVariables` (`@mantine/core`) emits each scheme's block as its own
 * `:root[data-mantine-color-scheme="<scheme>"], :host([data-mantine-color-scheme="<scheme>"]){...}`
 * rule. Pulls just that rule's declarations out of the full stylesheet text so an assertion about one
 * scheme can't accidentally match a declaration meant for the other. */
function schemeBlock(css: string, scheme: 'dark' | 'light'): string {
    return css.match(new RegExp(`data-mantine-color-scheme="${scheme}"\\][^{]*\\{([^}]*)\\}`))?.[1] ?? '';
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

describe('cssVariablesResolver (card 0179 — links unreadable in dark mode)', () => {
    // Without the resolver, Mantine's own default derives `--mantine-color-anchor` from
    // `primaryColor: 'dark'` — `var(--mantine-color-dark-4)` (`#424242`) in the dark scheme — which is
    // what made every `Anchor` in the app fail WCAG AA against the dark-scheme body. Pinning down that
    // baseline first is what makes the next test's override provable rather than assumed.
    it('defaults to the unreadable dark-4 token in the dark scheme when the resolver is not passed', () => {
        const dark = schemeBlock(renderedCssVariables(), 'dark');
        expect(dark).toMatch(/--mantine-color-anchor:\s*var\(--mantine-color-dark-4\);/);
    });

    // This is the actual fix: the resolver overrides that default to `theme.colors.dark[0]`
    // (`#C9C9C9`), the shade `theme.ts`'s doc comment measures at 9.37:1 against the dark-scheme body.
    it('overrides --mantine-color-anchor for the dark scheme to theme.colors.dark[0]', () => {
        const dark = schemeBlock(renderedCssVariablesWithResolver(), 'dark');
        expect(dark).toMatch(/--mantine-color-anchor:\s*#C9C9C9;/);
    });

    // The Constraints are explicit that light must not regress from its current 13.58:1 — this
    // resolver's own `light: {}` is what leaves Mantine's default (`var(--mantine-color-dark-6)`,
    // resolved from `primaryColor` for the light scheme) in place, identical with or without the
    // resolver wired in.
    it('leaves the light scheme\'s anchor colour at Mantine\'s own default, resolver or not', () => {
        const withoutResolver = schemeBlock(renderedCssVariables(), 'light');
        const withResolver = schemeBlock(renderedCssVariablesWithResolver(), 'light');
        expect(withResolver).toBe(withoutResolver);
        expect(withResolver).toMatch(/--mantine-color-anchor:\s*var\(--mantine-color-dark-6\);/);
    });
});
