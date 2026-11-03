import { describe, expect, it } from 'vitest';
import { lineNumberOn, parseHunks } from '#modules/review/diff.hunks.js';

const PATCH = [
    'diff --git a/a.ts b/a.ts',
    'index 1..2 100644',
    '--- a/a.ts',
    '+++ b/a.ts',
    '@@ -10,3 +10,3 @@ function outer() {',
    ' keep',
    '-gone',
    '+added',
    ' tail',
    '\\ No newline at end of file',
    '@@ -30 +30,2 @@',
    ' one',
    '+two',
    '',
].join('\n');

describe('parseHunks', () => {
    it('numbers each line on the sides it exists on', () => {
        const [first] = parseHunks(PATCH);

        expect(first!.lines).toEqual([
            { kind: 'context', text: 'keep', oldLine: 10, newLine: 10 },
            { kind: 'remove', text: 'gone', oldLine: 11, newLine: undefined },
            { kind: 'add', text: 'added', oldLine: undefined, newLine: 11 },
            { kind: 'context', text: 'tail', oldLine: 12, newLine: 12 },
        ]);
    });

    it('takes a hunk length left out of the header to be one', () => {
        const [, second] = parseHunks(PATCH);

        expect(second).toMatchObject({ oldStart: 30, oldLines: 1, newStart: 30, newLines: 2 });
    });

    it('finds no hunks in a binary patch or an empty one', () => {
        expect(parseHunks('Binary files a/x and b/x differ\n')).toEqual([]);
        expect(parseHunks('')).toEqual([]);
    });
});

describe('lineNumberOn', () => {
    it('answers undefined for a side the line does not exist on', () => {
        const line = { kind: 'remove' as const, text: 'x', oldLine: 4, newLine: undefined };

        expect(lineNumberOn(line, 'old')).toBe(4);
        expect(lineNumberOn(line, 'new')).toBeUndefined();
    });
});
