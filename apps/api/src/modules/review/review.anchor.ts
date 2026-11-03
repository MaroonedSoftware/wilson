import type { DiffFileEntry } from '#modules/worktree/worktree.manager.js';
import { lineNumberOn, parseHunks, type DiffLine, type DiffSide } from './diff.hunks.js';

/** How many neighbouring lines a comment keeps on each side, for telling repeated lines apart. */
const CONTEXT_LINES = 3;

export interface LineAnchor {
    file: string;
    side: DiffSide;
    lineText: string;
    contextBefore: string[];
    contextAfter: string[];
}

export type AnchorLocation = { location: 'found'; currentLine: number } | { location: 'outdated' };

/** Every hunk's lines that exist on `side`, each hunk kept apart so context never reads across a gap. */
const linesOn = (file: DiffFileEntry, side: DiffSide): DiffLine[][] =>
    parseHunks(file.patch).map(hunk => hunk.lines.filter(line => lineNumberOn(line, side) !== undefined));

/** The anchor for `line` on `side` of `file`, or `undefined` when the diff shows no such line. */
export const captureLineAnchor = (file: DiffFileEntry, side: DiffSide, line: number): LineAnchor | undefined => {
    for (const lines of linesOn(file, side)) {
        const index = lines.findIndex(candidate => lineNumberOn(candidate, side) === line);
        if (index === -1) continue;
        return {
            file: file.path,
            side,
            lineText: lines[index]!.text,
            contextBefore: lines.slice(Math.max(0, index - CONTEXT_LINES), index).map(candidate => candidate.text),
            contextAfter: lines.slice(index + 1, index + 1 + CONTEXT_LINES).map(candidate => candidate.text),
        };
    }
    return undefined;
};

/** How many of `expected`'s lines match `actual`, walking outward from the anchored line. */
const matching = (expected: string[], actual: string[]): number => {
    let count = 0;
    while (count < expected.length && expected[count] === actual[count]) count += 1;
    return count;
};

/**
 * Where a comment's line is in the diff now, by the rule `locateAnchor` (`apps/web/src/lib/anchor.ts`)
 * applies to a plan draft. A line with no match is outdated, and one match is found even if its
 * neighbours changed. Several matches are ranked by how many neighbours still match, and the strict
 * winner takes it, so a tie is outdated rather than a guess.
 *
 * A renamed file is outdated, because the diff shows it as a delete and an add under two paths.
 */
export const locateLineAnchor = (anchor: LineAnchor, files: DiffFileEntry[]): AnchorLocation => {
    const file = files.find(candidate => candidate.path === anchor.file);
    if (!file || file.truncated) return { location: 'outdated' };

    const candidates = linesOn(file, anchor.side).flatMap(lines =>
        lines.flatMap((line, index) => {
            if (line.text !== anchor.lineText) return [];
            const before = lines.slice(0, index).map(candidate => candidate.text);
            const after = lines.slice(index + 1).map(candidate => candidate.text);
            return [
                {
                    currentLine: lineNumberOn(line, anchor.side)!,
                    score: matching([...anchor.contextBefore].reverse(), before.reverse()) + matching(anchor.contextAfter, after),
                },
            ];
        }),
    );

    const [best, second] = [...candidates].sort((a, b) => b.score - a.score);
    if (!best || (second && second.score === best.score)) return { location: 'outdated' };
    return { location: 'found', currentLine: best.currentLine };
};
