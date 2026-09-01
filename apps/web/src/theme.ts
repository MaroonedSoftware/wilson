import { Anchor, createTheme, type CSSVariablesResolver } from '@mantine/core';

/**
 * Wired into `MantineProvider` by `main.tsx`. `brand/README.md` is the source of truth this follows:
 *
 * - `primaryColor: 'dark'` — monochrome per the brand guide ("one colour only"). Every stage's own
 *   `TONE` (`Board.tsx`) is the deliberate exception the Constraints call out, untouched by this.
 * - `headings.fontFamily` is a serif stack, not a webfont asset — the brand guide's wordmark rule
 *   ("Wilson is a person's name") applies to every `Title`, including `__root.tsx`'s own, with no
 *   font file to load or flash before it's ready.
 * - `fontFamilyMonospace` is a system mono stack for the "mono lowercase `wilson` beside commands"
 *   rule and anywhere else code-like text renders (`Code`, `Kbd`, diffs).
 * - `defaultRadius: 'sm'` is a deliberate pick, not Mantine's own default (`'md'`) — the brand guide
 *   asks for no ornament beyond the mark itself, and a tighter radius reads plainer on `Paper`/
 *   `Badge`/`Button` throughout the app than the rounder default would.
 * - `components.Anchor` defaults every `Anchor`/`AnchorLink` to `underline: 'always'` — card 0179,
 *   documented in full beside `cssVariablesResolver` below, where the anchor colour it's compensating
 *   for is chosen.
 */
export const theme = createTheme({
    primaryColor: 'dark',
    headings: {
        fontFamily: 'Georgia, Cambria, "Times New Roman", Times, serif',
    },
    fontFamilyMonospace: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
    defaultRadius: 'sm',
    components: {
        Anchor: Anchor.extend({ defaultProps: { underline: 'always' } }),
    },
});

/**
 * Card 0179. Mantine derives `--mantine-color-anchor` from `primaryColor` — `var(--mantine-color-
 * dark-4)` (`#424242`) in the dark scheme, since `primaryColor: 'dark'` above is a monochrome scale
 * rather than a hue with its own light/dark-friendly shades. Against this app's dark-scheme body
 * (`--mantine-color-body`, `var(--mantine-color-dark-7)` = `#242424`) that's 1.54:1, far under WCAG
 * AA's 4.5:1 — every `Anchor` in the app was unreadable in dark mode.
 *
 * Overridden here to `theme.colors.dark[0]` (`#c9c9c9`), the same shade the dark scheme already uses
 * for body text (`--mantine-color-text`). That measures 9.37:1 against the body — comfortably past
 * AA — and matches what the header's project link already rendered before this card, once its own
 * `c="inherit"` workaround (`ProjectSwitcher.tsx`) is gone. Because that shade equals ordinary text
 * colour, colour alone no longer distinguishes a link from prose in the dark scheme (the Constraints
 * call this out) — and Mantine's own default underline (`underline: 'hover'`: no decoration at rest,
 * only on hover/active) isn't a persistent affordance either. So `theme`'s `components.Anchor` above
 * sets `underline: 'always'` as a theme-wide default: every text `Anchor`/`AnchorLink` in the app is
 * now underlined at rest, and that underline — not colour, not Mantine's own hover-only default — is
 * what marks it as a link. `ProjectSwitcher`'s single-project link opts back out with its own
 * `underline="never"`, deliberately: it wraps an icon, not text, so there is no prose to be confused
 * with, and the icon's `aria-label` is the affordance there instead.
 *
 * Light is untouched: the default resolves to `var(--mantine-color-dark-6)` there (Mantine's own
 * `primaryShade.light` of 6, applied to `primaryColor: 'dark'`) and already measures 13.58:1.
 */
export const cssVariablesResolver: CSSVariablesResolver = theme => ({
    variables: {},
    light: {},
    dark: {
        '--mantine-color-anchor': theme.colors.dark[0],
    },
});
