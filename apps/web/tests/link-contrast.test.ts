/**
 * Card 0180: nothing in the suite measured a rendered colour — `grep -rl "getComputedStyle\|
 * toHaveStyle" apps/web/tests/` returned nothing — so [[0179]]'s dashboard-link contrast regression
 * (`#424242` on `#242424`, 1.54:1 in dark mode) passed review and reached `main`, found only when a
 * person opened the page. This file is the fix: one assertion that the app's link colour clears WCAG
 * AA (4.5:1) against the surface it renders on, in both colour schemes.
 *
 * Mechanism (the plan's Task 1), in the order tried, cheapest first, and proven against the fixture
 * below before being trusted for the real assertion further down:
 *
 * 1. **Pure arithmetic over the values the theme declares — chosen.** [[0179]] landed its fix in
 *    `theme.ts`, but as a reference into Mantine's own colour scale (`theme.colors.dark[0]`), not a
 *    literal string in this app's source — so reading `theme.ts` alone doesn't reach the actual
 *    colour. `@mantine/core` publicly exports the same pure functions `MantineProvider` itself uses
 *    to turn a theme into colours (`DEFAULT_THEME`, `mergeMantineTheme`, `getPrimaryShade`), so this
 *    file merges this app's `theme` over Mantine's defaults and calls this app's own
 *    `cssVariablesResolver` on the result — exactly what `MantineProvider` would compute, with no DOM,
 *    no CSS, and no new tooling.
 * 2. **Render via jsdom and read the injected stylesheet text — not needed.** `theme.test.ts` (card
 *    0179) already proved this route works: `MantineCssVariables` injects a
 *    `<style data-mantine-styles>` tag whose text is the same values as plain strings. It would have
 *    been the fallback had the theme's colours not been reachable in plain JS, but option 1 reaches
 *    them directly, so the extra jsdom/`@testing-library/react`/`matchMedia`-stub weight buys nothing
 *    here.
 * 3. **`getComputedStyle` on a rendered `Anchor` — not attempted.** The plan's Constraints call this
 *    out explicitly: `css` is not enabled in `vitest.config.ts`, and whether jsdom resolves
 *    `var(--mantine-color-anchor)` through `getComputedStyle` is unproven either way. Option 1 made
 *    testing that unnecessary.
 * 4. **A real browser (Playwright) — not needed.** Out of proportion to one assertion, and the
 *    Constraints call it the last resort. Option 1 can already see the values directly.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME, getPrimaryShade, mergeMantineTheme } from '@mantine/core';
import { theme, cssVariablesResolver } from '#src/theme.js';

/**
 * WCAG 2.x contrast ratio between two sRGB hex colours (`#rgb` or `#rrggbb`). Standard relative-
 * luminance formula: https://www.w3.org/TR/WCAG21/#dfn-relative-luminance and
 * https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio. Always divides the lighter relative luminance by
 * the darker, so the two arguments are interchangeable.
 */
function contrastRatio(a: string, b: string): number {
    const ratio = (relativeLuminance(a) + 0.05) / (relativeLuminance(b) + 0.05);
    return ratio >= 1 ? ratio : 1 / ratio;
}

function relativeLuminance(hex: string): number {
    const [r, g, b] = hexToRgb(hex);
    return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

function hexToRgb(hex: string): [number, number, number] {
    const normalized = hex.replace('#', '');
    const expanded = normalized.length === 3 ? normalized.split('').map(c => c + c).join('') : normalized;
    const value = Number.parseInt(expanded, 16);
    return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function channelLuminance(channel: number): number {
    const s = channel / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

describe('contrastRatio (WCAG relative luminance), proven against the known fixture', () => {
    // Card 0179 measured these exact values off the live regression: the dark-scheme anchor colour
    // (`#424242`) against the dark-scheme body (`#242424`) was 1.54:1 — the check must call this a
    // failure — and `#c9c9c9` on that same body was 9.37:1 — the check must call this a pass. A
    // mechanism that can't tell these two apart is not a check, however plausible its code looks.
    it('reports the known-bad pair, #424242 on #242424, as failing 4.5:1', () => {
        expect(contrastRatio('#424242', '#242424')).toBeCloseTo(1.54, 2);
        expect(contrastRatio('#424242', '#242424')).toBeLessThan(4.5);
    });

    it('reports the known-good pair, #c9c9c9 on #242424, as passing 4.5:1', () => {
        expect(contrastRatio('#c9c9c9', '#242424')).toBeCloseTo(9.37, 2);
        expect(contrastRatio('#c9c9c9', '#242424')).toBeGreaterThanOrEqual(4.5);
    });

    it('is symmetric: swapping the two colours does not change the ratio', () => {
        expect(contrastRatio('#424242', '#242424')).toBe(contrastRatio('#242424', '#424242'));
    });
});

describe("the app's link colour against its background (card 0179's fix in theme.ts)", () => {
    // The full theme `MantineProvider` would compute: this app's overrides merged onto Mantine's own
    // defaults, the same merge `MantineProvider` performs internally before calling any resolver.
    const merged = mergeMantineTheme(DEFAULT_THEME, theme);

    it('clears 4.5:1 in the dark scheme', () => {
        // Card 0179's fix: cssVariablesResolver overrides the dark-scheme anchor to
        // theme.colors.dark[0]. The dark-scheme body is Mantine's own default (unrelated to
        // primaryColor): --mantine-color-body: var(--mantine-color-dark-7).
        const anchor = cssVariablesResolver(merged).dark['--mantine-color-anchor']!;
        const body = merged.colors.dark[7];
        expect(contrastRatio(anchor, body)).toBeGreaterThanOrEqual(4.5);
    });

    it('clears 4.5:1 in the light scheme', () => {
        // Card 0179 leaves light untouched (cssVariablesResolver's light: {}), so both the anchor and
        // the body fall back to Mantine's own defaults: the anchor to the primary colour at
        // primaryShade.light, the body to theme.white.
        const anchor = merged.colors[merged.primaryColor]![getPrimaryShade(merged, 'light')];
        const body = merged.white;
        expect(contrastRatio(anchor, body)).toBeGreaterThanOrEqual(4.5);
    });
});
