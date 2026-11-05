/** One line a card added, numbered as it now stands in the file. */
export interface AddedLine {
    line: number;
    text: string;
}

const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * The added lines of one file's `git diff --unified=0`. It counts each hunk's lines off its header
 * rather than trusting a leading `+`, so a removed `-- x` or an added `++ x` cannot be mistaken for
 * the patch's own framing. A binary file has no hunks and so no lines.
 */
export const addedLinesFromPatch = (patch: string): AddedLine[] => {
    const added: AddedLine[] = [];
    const rows = patch.split('\n');
    for (let index = 0; index < rows.length; index++) {
        const header = HUNK_HEADER.exec(rows[index]!);
        if (!header) continue;

        let removedLeft = Number(header[1] ?? 1);
        let addedLeft = Number(header[3] ?? 1);
        let line = Number(header[2]);
        while ((removedLeft > 0 || addedLeft > 0) && index + 1 < rows.length) {
            const row = rows[++index]!;
            if (row.startsWith('-')) removedLeft--;
            else if (row.startsWith('+')) {
                added.push({ line: line++, text: row.slice(1) });
                addedLeft--;
            }
        }
    }
    return added;
};
