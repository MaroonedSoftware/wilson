import picomatch from 'picomatch';

/** One pair of patterns, one from each side, that can match a common path. */
export interface OverlappingPatterns {
    /** The pattern from the first scope. */
    ours: string;
    /** The pattern from the second scope. */
    theirs: string;
}

/** Characters that make a single path segment a glob rather than a literal. */
const SEGMENT_META = /[*?[\]{}]/;

/** The index of the first meta character in a segment, or the segment's length if it has none. */
const firstMetaIndex = (segment: string): number => {
    const index = segment.split('').findIndex(ch => SEGMENT_META.test(ch));
    return index === -1 ? segment.length : index;
};

/** The index of the last meta character in a segment, or -1 if it has none. */
const lastMetaIndex = (segment: string): number => {
    let index = -1;
    for (let i = 0; i < segment.length; i++) {
        if (SEGMENT_META.test(segment[i]!)) index = i;
    }
    return index;
};

/**
 * Whether two single-path-segment glob patterns (no `/` in either) can match a common string.
 *
 * Two literals overlap only when equal. A literal against a glob is answered exactly, by matching
 * the literal against the glob with picomatch. Two globs against each other has no exact answer
 * without enumerating strings, so this falls back to comparing the literal prefix and suffix each
 * pattern requires: for a common string to exist, one pattern's required prefix must be consistent
 * with the other's (one a prefix of the other), and likewise for the suffix. `*.ts` and `*.md`
 * disagree on suffix and are correctly called disjoint; `*.ts` and `jobs.*` agree on both (empty
 * prefix, empty suffix) and are correctly called overlapping.
 */
const segmentsOverlap = (a: string, b: string): boolean => {
    if (a === b) return true;

    const aIsGlob = SEGMENT_META.test(a);
    const bIsGlob = SEGMENT_META.test(b);

    if (!aIsGlob && !bIsGlob) return false;
    if (!aIsGlob) return picomatch(b, { dot: true })(a);
    if (!bIsGlob) return picomatch(a, { dot: true })(b);

    const prefixA = a.slice(0, firstMetaIndex(a));
    const prefixB = b.slice(0, firstMetaIndex(b));
    if (!prefixA.startsWith(prefixB) && !prefixB.startsWith(prefixA)) return false;

    const suffixA = a.slice(lastMetaIndex(a) + 1);
    const suffixB = b.slice(lastMetaIndex(b) + 1);
    return suffixA.endsWith(suffixB) || suffixB.endsWith(suffixA);
};

/**
 * Whether two `Files in scope` patterns can match a common path, compared segment by segment.
 *
 * `**` is the one segment given special meaning — a whole path segment matching zero or more path
 * segments, the same meaning picomatch and every card's plan give it — so `apps/api/src/modules/
 * jobs/**` overlaps `apps/api/src/modules/jobs/jobs.module.ts` even though the second names a file
 * the first never spells out. Every other segment is compared with {@link segmentsOverlap}. This is
 * pattern-vs-pattern, not pattern-vs-path: it is not enough for one pattern to match a path the
 * other could also match against some *other* string, both patterns have to agree the *same* string
 * is fair game.
 */
const patternsOverlap = (a: string, b: string): boolean => {
    const segsA = a.split('/');
    const segsB = b.split('/');
    const cache = new Map<string, boolean>();

    const walk = (i: number, j: number): boolean => {
        const key = `${i},${j}`;
        const cached = cache.get(key);
        if (cached !== undefined) return cached;

        let result: boolean;
        if (i === segsA.length && j === segsB.length) {
            result = true;
        } else if (i === segsA.length) {
            result = segsB.slice(j).every(seg => seg === '**');
        } else if (j === segsB.length) {
            result = segsA.slice(i).every(seg => seg === '**');
        } else if (segsA[i] === '**') {
            result = walk(i + 1, j) || walk(i, j + 1);
        } else if (segsB[j] === '**') {
            result = walk(i, j + 1) || walk(i + 1, j);
        } else {
            result = segmentsOverlap(segsA[i]!, segsB[j]!) && walk(i + 1, j + 1);
        }

        cache.set(key, result);
        return result;
    };

    return walk(0, 0);
};

/**
 * Every pair of patterns, one from each scope, that can match a common path.
 *
 * Pure — no repository, no filesystem, like {@link import('./next.card.js').nextCard} — so it is
 * testable against plain string arrays and reasoned about without standing up a board. Compares
 * globs against globs, not resolved files (PROJECT.md card 0069): `Files in scope` holds patterns
 * deliberately, so a plan need not predict every file it creates, and two cards collide when their
 * pattern sets *can* match a common path even if neither names one outright.
 *
 * An empty result means the scopes cannot collide; it says nothing about whether either card is
 * actually in flight; the caller decides that.
 */
export const scopeOverlap = (a: readonly string[], b: readonly string[]): OverlappingPatterns[] => {
    const overlaps: OverlappingPatterns[] = [];
    for (const ours of a) {
        for (const theirs of b) {
            if (patternsOverlap(ours, theirs)) overlaps.push({ ours, theirs });
        }
    }
    return overlaps;
};
