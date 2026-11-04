import ts from 'typescript';

/**
 * The test files this guard reads. Wider than `TestingVerifier`'s `*.test.ts`, because a file this
 * parser can read should not escape by being called `.spec.js`. Other languages are out of scope.
 */
const ASSERTION_TEST_FILE_PATTERN = /(^|\/)[^/]*\.(test|spec)\.[cm]?[jt]sx?$/;

export const isAssertionTestFile = (path: string): boolean => ASSERTION_TEST_FILE_PATTERN.test(path);

/** A helper named for what it asserts: `expectSkipped(`, not `expected(` or `expectations(`. */
const EXPECT_HELPER_NAME = /^expect[A-Z0-9_]/;

/** The members of `expect` that assert something. `expect.anything()` and friends only describe a value. */
const ASSERTING_EXPECT_MEMBERS = new Set(['soft', 'poll']);

const EQUALITY_MATCHERS = new Set(['toBe', 'toEqual', 'toStrictEqual']);

/** One assertion as the source wrote it. `text` is its whole chain with whitespace collapsed. */
export interface FoundAssertion {
    line: number;
    text: string;
}

export interface AssertionScan {
    assertions: FoundAssertion[];
    /** The assertions that compare two literals and can only pass. A subset of `assertions`. */
    tautologies: FoundAssertion[];
}

const isCountedCall = (call: ts.CallExpression): boolean => {
    const callee = call.expression;
    if (ts.isIdentifier(callee)) return callee.text === 'expect' || EXPECT_HELPER_NAME.test(callee.text);
    if (!ts.isPropertyAccessExpression(callee)) return false;

    const member = callee.name.text;
    if (ts.isIdentifier(callee.expression) && callee.expression.text === 'expect') return ASSERTING_EXPECT_MEMBERS.has(member);
    return member === 'expect' || EXPECT_HELPER_NAME.test(member);
};

/** Climb from `expect(x)` to the `expect(x).not.toBe(y)` that holds it. */
const wholeChain = (node: ts.Expression): ts.Expression => {
    let current = node;
    while ((ts.isPropertyAccessExpression(current.parent) || ts.isCallExpression(current.parent)) && current.parent.expression === current) {
        current = current.parent;
    }
    return current;
};

const withoutWrappers = (node: ts.Expression): ts.Expression => {
    let current = node;
    while (
        ts.isParenthesizedExpression(current) ||
        ts.isAsExpression(current) ||
        ts.isSatisfiesExpression(current) ||
        ts.isNonNullExpression(current)
    ) {
        current = current.expression;
    }
    return current;
};

/** A literal's value in a form that compares equal only when the two values would. */
const literalKey = (node: ts.Expression): string | undefined => {
    const value = withoutWrappers(node);
    if (value.kind === ts.SyntaxKind.TrueKeyword) return 'true';
    if (value.kind === ts.SyntaxKind.FalseKeyword) return 'false';
    if (value.kind === ts.SyntaxKind.NullKeyword) return 'null';
    if (ts.isIdentifier(value) && value.text === 'undefined') return 'undefined';
    if (ts.isStringLiteralLike(value)) return `string:${value.text}`;
    if (ts.isNumericLiteral(value)) return `number:${Number(value.text)}`;
    if (ts.isBigIntLiteral(value)) return `bigint:${value.text}`;
    if (ts.isPrefixUnaryExpression(value) && value.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(value.operand)) {
        return `number:-${Number(value.operand.text)}`;
    }
    return undefined;
};

/**
 * `expect(true).toBe(true)`, `expect('a').toEqual('a')` or `expect(1).not.toBe(2)`: two literals and
 * a matcher that can only pass. This is deliberately all it knows. `.toBeTruthy()`, `.toBeDefined()`,
 * `.not.toThrow()` and `expect.anything()` are weak but have hundreds of real uses, and a guard that
 * cries wolf gets declared around. A literal pair that can only fail is the red suite's business.
 */
const isTautology = (call: ts.CallExpression): boolean => {
    const callee = call.expression;
    if (!ts.isPropertyAccessExpression(callee) || !EQUALITY_MATCHERS.has(callee.name.text) || call.arguments.length !== 1) return false;

    const negated = ts.isPropertyAccessExpression(callee.expression) && callee.expression.name.text === 'not';
    const subject = negated ? (callee.expression as ts.PropertyAccessExpression).expression : callee.expression;
    if (!ts.isCallExpression(subject) || subject.arguments.length === 0) return false;

    const root = subject.expression;
    const isExpect = ts.isIdentifier(root)
        ? root.text === 'expect'
        : ts.isPropertyAccessExpression(root) && ts.isIdentifier(root.expression) && root.expression.text === 'expect' && root.name.text === 'soft';
    if (!isExpect) return false;

    const actual = literalKey(subject.arguments[0]!);
    const expected = literalKey(call.arguments[0]!);
    if (actual === undefined || expected === undefined) return false;
    return (actual === expected) !== negated;
};

/**
 * The assertions a test file's source holds. It reads the syntax tree rather than the text, so an
 * assertion commented out stops counting and one quoted in a fixture string never counted. The
 * parser recovers from a syntax error rather than throwing, and a file that broken also fails the suite.
 */
export const scanAssertions = (path: string, source: string): AssertionScan => {
    // The name picks the dialect: TSX needs parsing as such, and `<T>x` means something else there.
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    const found = (node: ts.Expression): FoundAssertion => ({
        line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
        text: node.getText(file).replace(/\s+/g, ' '),
    });

    const scan: AssertionScan = { assertions: [], tautologies: [] };
    const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
            if (isCountedCall(node)) scan.assertions.push(found(wholeChain(node)));
            if (isTautology(node)) scan.tautologies.push(found(node));
        }
        ts.forEachChild(node, visit);
    };
    visit(file);
    return scan;
};

/** A test file a card changed, by side. A side it does not have is unset: added files have no `base`. */
export interface TestFileSides {
    path: string;
    base?: string;
    current?: string;
}

export interface LocatedAssertion extends FoundAssertion {
    path: string;
}

export interface AssertionDelta {
    baseCount: number;
    currentCount: number;
    /**
     * Assertions at base with no match anywhere in the card's current files, located on the base
     * side. Files that lost the most come first, so the first entry is the one to name.
     */
    lost: LocatedAssertion[];
    /** Tautologies in the current files that the changed files did not already hold at base. */
    newTautologies: LocatedAssertion[];
}

/** Take `wanted` from `pool`, returning those `pool` had none left of. Matches by text across files. */
const unmatched = (wanted: LocatedAssertion[], pool: LocatedAssertion[]): LocatedAssertion[] => {
    const remaining = new Map<string, number>();
    for (const { text } of pool) remaining.set(text, (remaining.get(text) ?? 0) + 1);

    return wanted.filter(({ text }) => {
        const left = remaining.get(text) ?? 0;
        if (left === 0) return true;
        remaining.set(text, left - 1);
        return false;
    });
};

/**
 * What a card did to its assertions, judged across all of its changed test files together: a test
 * moved to another file is neither a loss nor a new tautology. Pure, so that reading the two sides,
 * which may happen on another machine, stays with the caller.
 */
export const assertionDelta = (files: TestFileSides[]): AssertionDelta => {
    const collect = (side: 'base' | 'current', part: keyof AssertionScan): LocatedAssertion[] =>
        files.flatMap(file => {
            const source = file[side];
            if (source === undefined) return [];
            return scanAssertions(file.path, source)[part].map(assertion => ({ ...assertion, path: file.path }));
        });

    const base = collect('base', 'assertions');
    const current = collect('current', 'assertions');

    const netLoss = new Map<string, number>();
    for (const { path } of base) netLoss.set(path, (netLoss.get(path) ?? 0) + 1);
    for (const { path } of current) netLoss.set(path, (netLoss.get(path) ?? 0) - 1);

    return {
        baseCount: base.length,
        currentCount: current.length,
        lost: unmatched(base, current).sort((a, b) => (netLoss.get(b.path) ?? 0) - (netLoss.get(a.path) ?? 0)),
        newTautologies: unmatched(collect('current', 'tautologies'), collect('base', 'tautologies')),
    };
};
