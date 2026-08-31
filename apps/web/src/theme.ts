import { createTheme } from '@mantine/core';

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
