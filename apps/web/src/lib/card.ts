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
