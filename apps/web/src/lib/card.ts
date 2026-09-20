/** A line's bullet marker (`-`, `*` or `+`), with any leading indentation and trailing spaces after it. */
const BULLET_MARKER = /^\s*[-*+]\s*/;

/**
 * Split a plan-contract section into its bullets.
 *
 * Mirrors `splitBullets` in the API (`apps/api/src/modules/board/card.ts`) — the web keeps its own
 * deliberate copy rather than importing across the app/api boundary. Same continuation rule: a
 * non-blank line without a marker of its own continues the bullet above it, joined with a single
 * space, so a criterion wrapped across several lines reads as one sentence. Same blank-line
 * boundary: a blank line ends the current bullet, so two bullets separated by one never join. A
 * section whose lines carry no bullet marker at all keeps one-item-per-line behaviour. Bullet
 * markers and inline code backticks are stripped, and HTML comment lines dropped.
 */
const splitBullets = (raw: string): string[] => {
    const lines = raw.split('\n');
    const clean = (line: string) => line.replace(/`/g, '').trim();
    const hasMarkers = lines.some(line => line.trim().length > 0 && BULLET_MARKER.test(line));

    if (!hasMarkers) {
        return lines.map(clean).filter(line => line.length > 0 && !line.startsWith('<!--'));
    }

    const items: string[] = [];
    let current: string | undefined;

    for (const line of lines) {
        if (line.trim().length === 0) {
            if (current !== undefined) items.push(current);
            current = undefined;
            continue;
        }
        if (line.trim().startsWith('<!--')) continue;
        if (BULLET_MARKER.test(line)) {
            if (current !== undefined) items.push(current);
            current = clean(line.replace(BULLET_MARKER, ''));
        } else {
            const cleaned = clean(line);
            current = current === undefined ? cleaned : `${current} ${cleaned}`;
        }
    }
    if (current !== undefined) items.push(current);
    return items.filter(item => item.length > 0);
};

/**
 * The globs listed under a card's "Files in scope" section, as plain strings.
 *
 * Mirrors `filesInScope` in the API (`apps/api/src/modules/board/card.ts`) closely enough to show
 * the same list an operator would see in the plan file — bullet markers and inline-code backticks
 * are formatting, not part of the glob — without importing across the app/api boundary.
 */
export const filesInScope = (sectionText: string | undefined): string[] => {
    if (!sectionText) return [];
    return splitBullets(sectionText);
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
 * the section's bullets. Same bullet stripping as `filesInScope`, via `splitBullets`, before IDs are
 * assigned.
 */
export const acceptanceCriteria = (sectionText: string | undefined): { id: string; text: string }[] => {
    if (!sectionText) return [];
    const bullets = splitBullets(sectionText);

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
