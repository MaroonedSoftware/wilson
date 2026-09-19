/**
 * The globs listed under a card's "Files in scope" section, as plain strings.
 *
 * Mirrors `filesInScope` in the API (`apps/api/src/modules/board/card.ts`) closely enough to show
 * the same list an operator would see in the plan file — bullet markers and inline-code backticks
 * are formatting, not part of the glob — without importing across the app/api boundary.
 */
export const filesInScope = (sectionText: string | undefined): string[] => {
    if (!sectionText) return [];
    return sectionText
        .split('\n')
        .map(line =>
            line
                .replace(/^\s*[-*+]\s*/, '')
                .replace(/`/g, '')
                .trim(),
        )
        .filter(line => line.length > 0 && !line.startsWith('<!--'));
};

/** A leading `AC1:`, `AC-1:` or `AC1.` token on a bullet, normalized to `AC<n>`. */
const ACCEPTANCE_CRITERION_ID = /^AC-?(\d+)[:.]\s*(.*)$/;

/**
 * The plan's acceptance criteria, each with a stable ID and its text.
 *
 * Mirrors `acceptanceCriteria` in the API (`apps/api/src/modules/board/card.ts`), the same pattern
 * `filesInScope` above already follows: the web keeps its own deliberate copy rather than importing
 * across the app/api boundary. Same ID rule: a leading `AC1:`, `AC-1:` or `AC1.` token on a bullet is
 * its ID, normalized to `AC<n>`; a bullet without one gets a positional `AC<n>` from its order among
 * the section's bullets. Same bullet stripping as `filesInScope`: markers and inline code backticks
 * are stripped, and blank lines and HTML comments are dropped, before IDs are assigned.
 */
export const acceptanceCriteria = (sectionText: string | undefined): { id: string; text: string }[] => {
    if (!sectionText) return [];
    const bullets = sectionText
        .split('\n')
        .map(line =>
            line
                .replace(/^\s*[-*+]\s*/, '')
                .replace(/`/g, '')
                .trim(),
        )
        .filter(line => line.length > 0 && !line.startsWith('<!--'));

    return bullets.map((bulletText, index) => {
        const match = ACCEPTANCE_CRITERION_ID.exec(bulletText);
        return match ? { id: `AC${match[1]}`, text: match[2]!.trim() } : { id: `AC${index + 1}`, text: bulletText };
    });
};

/** A timestamp for reading, not for sorting — the API already returns rows newest/oldest as intended. */
export const formatTimestamp = (iso: string): string => new Date(iso).toLocaleString();

/**
 * The same six-heading skeleton `create.command.ts` seeds `$EDITOR` with
 * (`packages/cli/src/commands/card/create.command.ts`), duplicated here rather than imported —
 * `apps/web` does not depend on `packages/cli`, and this card is not the one to wire that up. A
 * card filed as a plan starts in the right shape; a parking-lot capture is free to clear this and
 * type prose instead, the same as it always has been from the CLI.
 */
export const CARD_BODY_SKELETON = `
## Goal

## Constraints

## Files in scope

## Tasks

## Acceptance criteria

## Out of scope
`;
