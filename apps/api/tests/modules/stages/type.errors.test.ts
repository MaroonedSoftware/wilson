import { describe, expect, it } from 'vitest';
import { netNewTypeErrors, parseTypeErrors } from '#modules/stages/type.errors.js';

describe('parseTypeErrors', () => {
    it('reads plain tsc output and ignores everything else', () => {
        const output = [
            '$ tsc -p tsconfig.json',
            "src/x.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
            '  Details follow.',
        ].join('\n');
        expect(parseTypeErrors(output)).toEqual([
            { file: 'src/x.ts', line: 3, column: 7, code: 'TS2322', message: "Type 'string' is not assignable to type 'number'." },
        ]);
    });

    it('strips the turbo prefix and keeps its package, so src/x.ts in two packages stays two files', () => {
        const output = '@wilson/api:typecheck: src/x.ts(1,1): error TS1: a\n@wilson/web:typecheck: src/x.ts(1,1): error TS1: a';
        expect(parseTypeErrors(output).map(error => [error.scope, error.file])).toEqual([
            ['@wilson/api', 'src/x.ts'],
            ['@wilson/web', 'src/x.ts'],
        ]);
    });

    it('reads pretty output with colour', () => {
        const output =
            '\u001b[96msrc/x.ts\u001b[0m:\u001b[93m3\u001b[0m:\u001b[93m7\u001b[0m - \u001b[91merror\u001b[0m\u001b[90m TS2322: \u001b[0mNope.';
        expect(parseTypeErrors(output)).toEqual([{ file: 'src/x.ts', line: 3, column: 7, code: 'TS2322', message: 'Nope.' }]);
    });

    it('reads an error with no file', () => {
        expect(parseTypeErrors('error TS5083: Cannot read file.')).toEqual([{ file: '', code: 'TS5083', message: 'Cannot read file.' }]);
    });

    it('removes the tree from paths and messages, so one error reads the same in two trees', () => {
        const line = (root: string) => `${root}/src/x.ts(1,1): error TS2322: Type 'import("${root}/src/y").Y' is wrong.`;
        expect(parseTypeErrors(line('/trees/a'), '/trees/a')).toEqual(parseTypeErrors(line('/trees/b'), '/trees/b'));
    });

    it('does not take an ordinary log line for a prefix or an error', () => {
        expect(parseTypeErrors('Tasks:    5 successful, 5 total\n@wilson/api:typecheck: cache hit, replaying logs abc')).toEqual([]);
    });
});

describe('netNewTypeErrors', () => {
    const error = (file: string, line: number, message = 'nope', code = 'TS2322') => ({ file, line, column: 1, code, message });

    it('does not count an existing error that moved to another line', () => {
        expect(netNewTypeErrors([error('a.ts', 40)], [error('a.ts', 3)])).toEqual([]);
    });

    it('counts a different message, code or file as new', () => {
        const base = [error('a.ts', 1)];
        expect(netNewTypeErrors([error('a.ts', 1, 'other')], base)).toHaveLength(1);
        expect(netNewTypeErrors([error('a.ts', 1, 'nope', 'TS2345')], base)).toHaveLength(1);
        expect(netNewTypeErrors([error('b.ts', 1)], base)).toHaveLength(1);
    });

    it('counts a second identical error, and lists both places because they cannot be told apart', () => {
        expect(netNewTypeErrors([error('a.ts', 1), error('a.ts', 9)], [error('a.ts', 1)])).toEqual([
            { file: 'a.ts', code: 'TS2322', message: 'nope', locations: ['1:1', '9:1'], added: 1 },
        ]);
    });

    it('reports nothing for an error the branch fixed', () => {
        expect(netNewTypeErrors([], [error('a.ts', 1)])).toEqual([]);
    });
});
