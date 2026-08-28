/**
 * Finding a quoted passage of a plan draft again after the draft has been rewritten.
 *
 * Card 0122 wants comments anchored to passages of a draft, but the agent rewrites the whole
 * draft on every turn (PROJECT.md's "Interactive planning"), so an anchor built from a character
 * offset is wrong by the very next revision. An anchor here is the exact quoted text plus a
 * window of the text immediately before and after it, and locating one is a search over the
 * current draft, not a lookup by position.
 *
 * Pure and storage-free by design (this card's Constraints): given a document's text and an
 * anchor, `locateAnchor` returns where the quote is now, or that it could not be found. Nothing
 * here touches a database, a file, or React — [[0146]] is where an anchor gets a table and an
 * API, [[0147]] is where a browser selection becomes one of these and a location becomes a
 * highlight.
 */

/**
 * A captured quote and the text immediately surrounding it, as it read at capture time. No
 * offset: PROJECT.md's "Anchors are quote-based, not offsets" and this card's own constraint
 * ("Offsets are an output, never an input") rule out storing a position, because a position is
 * exactly what a rewrite invalidates.
 */
export interface Anchor {
    /** The selected text itself — what the person actually quoted. */
    quote: string;
    /** Up to `WINDOW_LENGTH` characters immediately before the quote, as captured. */
    prefix: string;
    /** Up to `WINDOW_LENGTH` characters immediately after the quote, as captured. */
    suffix: string;
}

/** A located span within a document's text, as character offsets — an output of `locateAnchor`, never an input anywhere in this module. */
export interface AnchorRange {
    start: number;
    end: number;
}

/** The result of searching a document's text for an anchor: found at a range, or outdated. */
export type LocateResult = { status: 'found'; range: AnchorRange } | { status: 'outdated' };

/**
 * How much surrounding text `captureAnchor` keeps, in characters on each side.
 *
 * The board has no prior instance of this kind of window to measure against — no comment
 * anchoring has shipped yet, so there is no revision history to calibrate a "how much editing
 * happens around a sentence" figure from, unlike `BREADTH_THRESHOLD`/`DEPTH_THRESHOLD`
 * (`scope.check.verifier.ts`), which are each tuned against specific cards that already ran.
 * This value is a starting guess, not a measurement: 60 characters is roughly a clause or short
 * sentence either side of the quote — enough that two occurrences of the same short phrase
 * sitting in different sentences usually read differently in their window, without reaching so
 * far that an edit to an unrelated part of the paragraph invalidates a window that never needed
 * to survive (see `locateAnchor`: the window disambiguates duplicates, it does not have to match
 * for a unique quote to be found). Revisit once real anchors have gone stale in practice and
 * there is board evidence to tune against.
 */
const WINDOW_LENGTH = 60;

/**
 * Builds an anchor from a selection within a document's text — `start`/`end` are what a browser
 * selection or any other capture yields, as offsets into this text. Offsets appear only as
 * parameters here, never inside the returned `Anchor`: this is the one place in the module
 * allowed to take a position, because it turns that position into a quote immediately and does
 * not keep it.
 */
export function captureAnchor(text: string, start: number, end: number): Anchor {
    return {
        quote: text.slice(start, end),
        prefix: text.slice(Math.max(0, start - WINDOW_LENGTH), start),
        suffix: text.slice(end, end + WINDOW_LENGTH),
    };
}

/** Every offset at which `quote` occurs in `text`, including overlapping occurrences. Empty quotes match nothing — an empty selection was never really "a passage" to anchor. */
const allOccurrences = (text: string, quote: string): number[] => {
    if (quote.length === 0) return [];
    const starts: number[] = [];
    let from = 0;
    for (;;) {
        const at = text.indexOf(quote, from);
        if (at === -1) break;
        starts.push(at);
        from = at + 1;
    }
    return starts;
};

/** How many characters match, walking backward from the end of both strings — used to score a candidate prefix against the anchor's. */
const trailingOverlap = (actual: string, expected: string): number => {
    const limit = Math.min(actual.length, expected.length);
    let n = 0;
    while (n < limit && actual[actual.length - 1 - n] === expected[expected.length - 1 - n]) n += 1;
    return n;
};

/** How many characters match, walking forward from the start of both strings — used to score a candidate suffix against the anchor's. */
const leadingOverlap = (actual: string, expected: string): number => {
    const limit = Math.min(actual.length, expected.length);
    let n = 0;
    while (n < limit && actual[n] === expected[n]) n += 1;
    return n;
};

/**
 * Finds where `anchor`'s quote now sits in `text`, or reports it outdated.
 *
 * PROJECT.md: "When a quote can no longer be located after a revision, the comment surfaces as
 * outdated rather than silently reattaching to the wrong line" — so a quote that matches nowhere
 * is `outdated`, not an error and not a best guess.
 *
 * A quote that matches exactly once is `found` at that occurrence, even if the surrounding text
 * has changed enough that `prefix`/`suffix` no longer match at all: the window exists to tell
 * two occurrences of the same text apart, and with only one occurrence there is nothing to tell
 * apart. Treating a reworded-but-unique quote as outdated would make almost every anchor
 * outdated after one turn, which is the opposite of what this card exists to do.
 *
 * A quote that matches more than once is disambiguated by how much of its window survives: each
 * occurrence is scored by the run of matching characters adjacent to the quote — its prefix
 * compared backward from the quote, its suffix forward from it — and the occurrence with the
 * strictly highest combined score wins. If two or more occurrences tie for the best score,
 * including a tie at zero (the window disambiguates none of them), there is no textual basis to
 * prefer one over another, and picking one anyway would be exactly the "silently reattach to the
 * wrong place" this module exists to avoid; that case is reported outdated too.
 */
export function locateAnchor(text: string, anchor: Anchor): LocateResult {
    const starts = allOccurrences(text, anchor.quote);
    if (starts.length === 0) return { status: 'outdated' };

    if (starts.length === 1) {
        const start = starts[0]!;
        return { status: 'found', range: { start, end: start + anchor.quote.length } };
    }

    const scored = starts.map(start => {
        const end = start + anchor.quote.length;
        const actualPrefix = text.slice(Math.max(0, start - anchor.prefix.length), start);
        const actualSuffix = text.slice(end, end + anchor.suffix.length);
        const score = trailingOverlap(actualPrefix, anchor.prefix) + leadingOverlap(actualSuffix, anchor.suffix);
        return { start, end, score };
    });

    const bestScore = Math.max(...scored.map(s => s.score));
    const winners = scored.filter(s => s.score === bestScore);
    if (winners.length !== 1) return { status: 'outdated' };

    const winner = winners[0]!;
    return { status: 'found', range: { start: winner.start, end: winner.end } };
}
