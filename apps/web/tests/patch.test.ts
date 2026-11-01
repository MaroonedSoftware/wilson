// Card 0265. `parsePatch` (`src/lib/patch.ts`) turns one file's raw unified patch text — exactly
// what `WorktreeManager.patchSinceFork` writes with `git diff` — into hunks `DiffPane.tsx` renders
// with real line numbers on both sides. These assertions fail on the pre-change tree: the module
// does not exist there.
import { describe, expect, it } from 'vitest';
import { parsePatch } from '#src/lib/patch.js';

describe('parsePatch', () => {
    it('assigns correct old/new line numbers to context, added and removed lines across several hunks (AC5)', () => {
        const patch = [
            'diff --git a/src/foo.ts b/src/foo.ts',
            'index 111..222 100644',
            '--- a/src/foo.ts',
            '+++ b/src/foo.ts',
            '@@ -1,4 +1,5 @@',
            ' line1',
            '-line2',
            '+line2-changed',
            '+line2b',
            ' line3',
            ' line4',
            '@@ -10,3 +11,3 @@',
            ' line10',
            '-line11',
            '+line11-changed',
            ' line12',
            '',
        ].join('\n');

        const hunks = parsePatch(patch);

        expect(hunks).toHaveLength(2);

        const first = hunks[0]!;
        const second = hunks[1]!;
        expect(first.header).toBe('@@ -1,4 +1,5 @@');
        expect(first).toMatchObject({ oldStart: 1, oldLines: 4, newStart: 1, newLines: 5 });
        expect(first.lines).toEqual([
            { kind: 'context', text: 'line1', oldLine: 1, newLine: 1 },
            { kind: 'remove', text: 'line2', oldLine: 2, newLine: undefined },
            { kind: 'add', text: 'line2-changed', oldLine: undefined, newLine: 2 },
            { kind: 'add', text: 'line2b', oldLine: undefined, newLine: 3 },
            { kind: 'context', text: 'line3', oldLine: 3, newLine: 4 },
            { kind: 'context', text: 'line4', oldLine: 4, newLine: 5 },
        ]);

        expect(second.header).toBe('@@ -10,3 +11,3 @@');
        expect(second.lines).toEqual([
            { kind: 'context', text: 'line10', oldLine: 10, newLine: 11 },
            { kind: 'remove', text: 'line11', oldLine: 11, newLine: undefined },
            { kind: 'add', text: 'line11-changed', oldLine: undefined, newLine: 12 },
            { kind: 'context', text: 'line12', oldLine: 12, newLine: 13 },
        ]);
    });

    it('parses to an empty array for a patch with no hunk headers, like a binary file diff', () => {
        const patch = 'diff --git a/x.png b/x.png\nindex 111..222 100644\nBinary files a/x.png and b/x.png differ\n';
        expect(parsePatch(patch)).toEqual([]);
    });

    it('parses to an empty array for an empty patch, the shape a truncated file leaves behind', () => {
        expect(parsePatch('')).toEqual([]);
    });

    it('skips a "no newline at end of file" marker rather than treating it as a line', () => {
        const patch = ['@@ -1,1 +1,1 @@', '-old', '+new', '\\ No newline at end of file', ''].join('\n');
        const hunks = parsePatch(patch);
        expect(hunks).toHaveLength(1);
        expect(hunks[0]!.lines).toEqual([
            { kind: 'remove', text: 'old', oldLine: 1, newLine: undefined },
            { kind: 'add', text: 'new', oldLine: undefined, newLine: 1 },
        ]);
    });

    it('defaults an omitted hunk line count to 1', () => {
        const patch = ['@@ -5 +5 @@', ' unchanged', ''].join('\n');
        const hunks = parsePatch(patch);
        expect(hunks[0]).toMatchObject({ oldStart: 5, oldLines: 1, newStart: 5, newLines: 1 });
        expect(hunks[0]!.lines).toEqual([{ kind: 'context', text: 'unchanged', oldLine: 5, newLine: 5 }]);
    });

    it('keeps the hunk header text verbatim, including any trailing function-context text git appends', () => {
        const patch = ['@@ -1,2 +1,2 @@ function foo() {', ' a', ' b', ''].join('\n');
        const hunks = parsePatch(patch);
        expect(hunks[0]!.header).toBe('@@ -1,2 +1,2 @@ function foo() {');
    });
});
