import { describe, expect, it } from 'vitest';
import { addedLinesFromPatch } from '#modules/worktree/added.lines.js';

const patch = (...rows: string[]): string => ['diff --git a/x b/x', '--- a/x', '+++ b/x', ...rows, ''].join('\n');

describe('addedLinesFromPatch', () => {
    it('numbers added lines as they now stand, across hunks', () => {
        expect(addedLinesFromPatch(patch('@@ -1,0 +2,2 @@', '+one', '+two', '@@ -9 +11 @@', '-old', '+new'))).toEqual([
            { line: 2, text: 'one' },
            { line: 3, text: 'two' },
            { line: 11, text: 'new' },
        ]);
    });

    it('does not take the file header, or content shaped like one, for framing', () => {
        expect(addedLinesFromPatch(patch('@@ -1 +1,2 @@', '--- removed', '+++ added', '+@@ -1 +1 @@'))).toEqual([
            { line: 1, text: '++ added' },
            { line: 2, text: '@@ -1 +1 @@' },
        ]);
    });

    it('steps over the no-newline marker', () => {
        expect(addedLinesFromPatch(patch('@@ -1 +1 @@', '-a', '\\ No newline at end of file', '+b', '\\ No newline at end of file'))).toEqual([
            { line: 1, text: 'b' },
        ]);
    });

    it('finds nothing in a binary file or a pure deletion', () => {
        expect(addedLinesFromPatch('Binary files a/x and b/x differ\n')).toEqual([]);
        expect(addedLinesFromPatch(patch('@@ -1,2 +0,0 @@', '-a', '-b'))).toEqual([]);
    });
});
