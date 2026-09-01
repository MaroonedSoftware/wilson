import { createTheme, type CSSVariablesResolver } from '@mantine/core';

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
 */
export const theme = createTheme({
    primaryColor: 'dark',
    headings: {
        fontFamily: 'Georgia, Cambria, "Times New Roman", Times, serif',
    },
    fontFamilyMonospace: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
    defaultRadius: 'sm',
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
 * colour, colour alone no longer distinguishes a link from prose in the dark scheme; the underline
 * `Anchor` renders by default is what carries that affordance now, so no `Anchor`/`AnchorLink` in the
 * app may opt out of it with `underline="never"` without another way to signal "this is a link".
 *
 * Light is untouched: the default resolves to `var(--mantine-color-dark-9)` there and already
 * measures 13.58:1.
 */
export const cssVariablesResolver: CSSVariablesResolver = theme => ({
    variables: {},
    light: {},
    dark: {
        '--mantine-color-anchor': theme.colors.dark[0],
    },
});
