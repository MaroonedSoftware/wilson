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
