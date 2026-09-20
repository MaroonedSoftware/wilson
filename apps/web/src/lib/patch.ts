/**
 * Card 0265. Parses one file's unified patch text — `CardDiffFile.patch`, exactly as
 * `WorktreeManager.patchSinceFork` writes it with `git diff` — into hunks `DiffPane.tsx` can render
 * with real line numbers on both sides.
 *
 * Deliberately not `apps/web/src/lib/diff.ts`: that module is an LCS over plan prose with no line
 * numbers and no context lines, and its own doc comment says at length the duplication from the
 * CLI's diffing is permanent (this card's Constraints). This is a different kind of input — a real
 * unified patch, with hunk headers and both file's line numbers to track — and gets its own parser
 * rather than bending that one to fit.
 */

export type DiffLineKind = 'context' | 'add' | 'remove';

export interface DiffLine {
    kind: DiffLineKind;
    text: string;
    /** The line's number in the old (left) file, absent for an added line. */
    oldLine: number | undefined;
    /** The line's number in the new (right) file, absent for a removed line. */
    newLine: number | undefined;
}

export interface DiffHunk {
    /** The raw `@@ -l,s +l,s @@ ...` header line, kept verbatim for display. */
    header: string;
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: DiffLine[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@.*$/;

/**
 * Parses a unified patch into hunks. Anything before the first `@@` line (`diff --git`, `index`,
 * `---`/`+++`) is skipped — those lines carry no line-numbered content — and so is a
 * "\ No newline at end of file" marker line, which is neither context, add nor remove. A patch with
 * no hunk headers at all (a binary file's "Binary files a/x and b/x differ", or a file whose patch
 * text `patchSinceFork` left empty because it was truncated) parses to an empty array — a caller
 * shows that as "no hunks to render", not an error.
 */
export function parsePatch(patch: string): DiffHunk[] {
    const hunks: DiffHunk[] = [];
    let current: DiffHunk | undefined;
    let oldLine = 0;
    let newLine = 0;

    for (const raw of patch.split('\n')) {
        const match = HUNK_HEADER.exec(raw);
        if (match) {
            const oldStart = Number(match[1]);
            const oldLines = match[2] !== undefined ? Number(match[2]) : 1;
            const newStart = Number(match[3]);
            const newLines = match[4] !== undefined ? Number(match[4]) : 1;
            current = { header: raw, oldStart, oldLines, newStart, newLines, lines: [] };
            hunks.push(current);
            oldLine = oldStart;
            newLine = newStart;
            continue;
        }

        if (!current) continue;
        if (raw.startsWith('\\')) continue;
        // The empty string split produces after a patch's trailing newline — not a real diff line,
        // since git always prefixes a genuine line (even a blank context one) with a marker.
        if (raw.length === 0) continue;

        const marker = raw[0];
        const text = raw.slice(1);

        if (marker === '+') {
            current.lines.push({ kind: 'add', text, oldLine: undefined, newLine });
            newLine += 1;
        } else if (marker === '-') {
            current.lines.push({ kind: 'remove', text, oldLine, newLine: undefined });
            oldLine += 1;
        } else if (marker === ' ') {
            current.lines.push({ kind: 'context', text, oldLine, newLine });
            oldLine += 1;
            newLine += 1;
        }
        // Any other marker (rare — a hunk-adjacent comment git itself never emits) is not a line to
        // render; skipped rather than guessed at.
    }

    return hunks;
}
