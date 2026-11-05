import { describe, expect, it } from 'vitest';
import { assertionDelta, isAssertionTestFile, scanAssertions } from '#modules/stages/assertion.delta.js';

const count = (source: string, path = 'a.test.ts'): number => scanAssertions(path, source).assertions.length;
const tautologies = (source: string): string[] => scanAssertions('a.test.ts', source).tautologies.map(t => t.text);

describe('isAssertionTestFile', () => {
    it.each(['a.test.ts', 'tests/a.test.tsx', 'x/a.spec.js', 'a.test.mjs', 'a.spec.cts', 'a.b.test.jsx'])('reads %s', path => {
        expect(isAssertionTestFile(path)).toBe(true);
    });

    it.each(['a.ts', 'tests/support/helper.ts', 'a.test.ts.snap', 'CardTest.kt', 'Card.test.cs', 'a.test.json'])('leaves out %s', path => {
        expect(isAssertionTestFile(path)).toBe(false);
    });
});

describe('scanAssertions: counting', () => {
    it('counts expect calls and expect-named helpers', () => {
        expect(count('expect(a).toBe(1); expectSkipped(b); expect_ok(c); expect2(d);')).toBe(4);
    });

    it('counts helpers and expect reached through an object', () => {
        expect(count('ctx.expect(a).toBe(1); helpers.expectOk(b); request.get("/").expect(200);')).toBe(3);
    });

    it('counts expect.soft and expect.poll', () => {
        expect(count('expect.soft(a).toBe(1); await expect.poll(() => b).toBe(2);')).toBe(2);
    });

    it('does not count asymmetric matchers or expect setup', () => {
        expect(
            count('expect.extend({}); expect.assertions(1); expect.hasAssertions(); const x = expect.anything(); const y = expect.any(String);'),
        ).toBe(0);
    });

    it('counts the assertion holding an asymmetric matcher once', () => {
        expect(count('expect(a).toEqual(expect.objectContaining({ b: expect.any(String) }));')).toBe(1);
    });

    it('does not count names that only start with the letters', () => {
        expect(count('expected(a); expectation(b); expectations(c); const expect1 = 1; unexpected(d);')).toBe(0);
    });

    it('does not count a helper being defined, only being called', () => {
        expect(count('const expectOk = (a) => a; function expectFine() {} expectOk(1);')).toBe(1);
    });

    it('does not count an assertion commented out', () => {
        expect(count('// expect(a).toBe(1);\n/* expect(b).toBe(2); */\nexpect(c).toBe(3);')).toBe(1);
    });

    it('does not count a fixture held in a string or template', () => {
        const source = [
            `const a = "it('old', () => { expect(1).toBe(1); });";`,
            "const b = `it('x', () => { expect(true).toBe(true); });`;",
            `const c = 'expect(2).toBe(2)';`,
        ].join('\n');
        expect(scanAssertions('a.test.ts', source)).toEqual({ assertions: [], tautologies: [] });
    });

    it('counts a call inside a template substitution, which is code', () => {
        expect(count('const a = `${expect(b).toBe(1)}`;')).toBe(1);
    });

    it('reports the line and the whole chain, whitespace collapsed', () => {
        expect(scanAssertions('a.test.ts', 'it("x", () => {\n    expect(a)\n        .not.toBe(1);\n});').assertions).toEqual([
            { line: 2, text: 'expect(a) .not.toBe(1)' },
        ]);
    });

    it('reads TSX and leaves a TS angle-bracket cast to the TS dialect', () => {
        expect(count('const v = <div>{expect(a).toBe(1)}</div>;', 'a.test.tsx')).toBe(1);
        expect(count('const v = <string>b; expect(v).toBe(1);', 'a.test.ts')).toBe(1);
    });

    it('does not throw on a file that does not parse', () => {
        expect(() => scanAssertions('a.test.ts', 'it("x", () => { expect(a).toBe(')).not.toThrow();
    });
});

describe('scanAssertions: tautologies', () => {
    it.each([
        'expect(true).toBe(true)',
        'expect(false).toBe(false)',
        'expect(null).toBe(null)',
        'expect(undefined).toBe(undefined)',
        'expect(1).toBe(1)',
        'expect(-1).toEqual(-1)',
        "expect('a').toEqual('a')",
        "expect('a').toStrictEqual(`a`)",
        'expect(1n).toBe(1n)',
        'expect(1).toBe(1.0)',
        'expect(1).not.toBe(2)',
        "expect('a').not.toEqual('b')",
        'expect(true).not.toBe(false)',
        'expect(null).not.toBe(undefined)',
        'expect(true as boolean).toBe(true)',
        'expect((true)).toBe(true)',
        'expect.soft(true).toBe(true)',
        "expect(true, 'it works').toBe(true)",
    ])('flags %s', source => {
        expect(tautologies(`${source};`)).toHaveLength(1);
    });

    it.each([
        'expect(value).toBe(true)',
        'expect(true).toBe(value)',
        'expect(result).toEqual(result)',
        'expect(a.b).toBe(1)',
        'expect(1).toBe(2)',
        "expect(1).toBe('1')",
        'expect(null).toBe(undefined)',
        'expect(0).toBe(-0)',
        'expect(1).not.toBe(1)',
        'expect(`${a}`).toBe(`${a}`)',
        'expect(value).toBeTruthy()',
        'expect(value).toBeDefined()',
        'expect(() => f()).not.toThrow()',
        'expect(value).toEqual(expect.anything())',
        'expect(1).toBeGreaterThan(0)',
        'expectOk(true).toBe(true)',
        'other(true).toBe(true)',
    ])('does not flag %s', source => {
        expect(tautologies(`${source};`)).toEqual([]);
    });

    // The rule is literal against literal, and these name no second literal. Pinned so that widening
    // it is a decision rather than an accident.
    it.each(['expect(true).toBeTruthy()', 'expect(1).toBeDefined()'])('does not flag a literal subject with a no-argument matcher: %s', source => {
        expect(tautologies(`${source};`)).toEqual([]);
    });

    it('still counts a tautology as an assertion', () => {
        expect(scanAssertions('a.test.ts', 'expect(true).toBe(true);').assertions).toHaveLength(1);
    });
});

describe('assertionDelta', () => {
    it('sees no change in an edit that keeps every assertion', () => {
        const delta = assertionDelta([{ path: 'a.test.ts', base: 'expect(a).toBe(1);', current: 'const b = 2;\nexpect(a).toBe(1);' }]);
        expect(delta).toEqual({ baseCount: 1, currentCount: 1, lost: [], newTautologies: [] });
    });

    it('catches an assertion replaced by a tautology with the count unchanged', () => {
        const delta = assertionDelta([{ path: 'a.test.ts', base: 'expect(a).toBe(1);', current: 'expect(true).toBe(true);' }]);
        expect(delta.baseCount).toBe(delta.currentCount);
        expect(delta.newTautologies).toEqual([{ path: 'a.test.ts', line: 1, text: 'expect(true).toBe(true)' }]);
    });

    it('nets a test moved between files to nothing', () => {
        const delta = assertionDelta([
            { path: 'a.test.ts', base: 'expect(a).toBe(1);\nexpect(true).toBe(true);' },
            { path: 'b.test.ts', current: 'expect(true).toBe(true);\nexpect(a).toBe(1);' },
        ]);
        expect(delta).toEqual({ baseCount: 2, currentCount: 2, lost: [], newTautologies: [] });
    });

    it('nets a drop in one file against new assertions in another', () => {
        const delta = assertionDelta([
            { path: 'a.test.ts', base: 'expect(a).toBe(1);\nexpect(b).toBe(2);', current: '' },
            { path: 'b.test.ts', current: 'expect(c).toBe(3);\nexpect(d).toBe(4);\nexpect(e).toBe(5);' },
        ]);
        expect(delta.currentCount - delta.baseCount).toBe(1);
    });

    it('counts a deleted file as a loss, located on the base side', () => {
        const delta = assertionDelta([{ path: 'a.test.ts', base: '\n\nexpect(a).toBe(1);' }]);
        expect(delta).toEqual({
            baseCount: 1,
            currentCount: 0,
            lost: [{ path: 'a.test.ts', line: 3, text: 'expect(a).toBe(1)' }],
            newTautologies: [],
        });
    });

    it('does not call a tautology new when another copy already stood at base', () => {
        const delta = assertionDelta([
            { path: 'a.test.ts', base: 'expect(true).toBe(true);', current: 'expect(true).toBe(true);\nexpect(true).toBe(true);' },
        ]);
        expect(delta.newTautologies).toEqual([{ path: 'a.test.ts', line: 2, text: 'expect(true).toBe(true)' }]);
    });

    it('names first the file that lost the most', () => {
        const delta = assertionDelta([
            { path: 'a.test.ts', base: 'expect(a).toBe(1);', current: '' },
            { path: 'b.test.ts', base: 'expect(b).toBe(1);\nexpect(c).toBe(1);', current: '' },
        ]);
        expect(delta.lost[0]?.path).toBe('b.test.ts');
    });

    it('never finds an empty card weakened', () => {
        expect(assertionDelta([])).toEqual({ baseCount: 0, currentCount: 0, lost: [], newTautologies: [] });
    });
});
