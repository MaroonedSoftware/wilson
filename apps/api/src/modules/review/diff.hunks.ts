/** Which file of a diff a line belongs to: `old` is the fork point, `new` the reviewed commit. */
export type DiffSide = 'old' | 'new';

export type DiffLineKind = 'context' | 'add' | 'remove';

export interface DiffLine {
    kind: DiffLineKind;
    text: string;
    /** The line's number in the old file, absent for an added line. */
    oldLine: number | undefined;
    /** The line's number in the new file, absent for a removed line. */
    newLine: number | undefined;
}

export interface DiffHunk {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: DiffLine[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parses one file's unified patch into hunks, for locating a comment or a tour step on the server.
 * The same reading of a patch as `apps/web/src/lib/patch.ts`, which renders it: anything before the
 * first `@@` is skipped, as is a "\ No newline at end of file" marker, and a patch with no hunks (a
 * binary file, a truncated one) parses to an empty array.
 */
export const parseHunks = (patch: string): DiffHunk[] => {
    const hunks: DiffHunk[] = [];
    let current: DiffHunk | undefined;
    let oldLine = 0;
    let newLine = 0;

    for (const raw of patch.split('\n')) {
        const match = HUNK_HEADER.exec(raw);
        if (match) {
            oldLine = Number(match[1]);
            newLine = Number(match[3]);
            current = {
                oldStart: oldLine,
                oldLines: match[2] !== undefined ? Number(match[2]) : 1,
                newStart: newLine,
                newLines: match[4] !== undefined ? Number(match[4]) : 1,
                lines: [],
            };
            hunks.push(current);
            continue;
        }
        if (!current) continue;

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
    }

    return hunks;
};

/** The line's number on `side`, or `undefined` when it does not exist there. */
export const lineNumberOn = (line: DiffLine, side: DiffSide): number | undefined => (side === 'old' ? line.oldLine : line.newLine);
