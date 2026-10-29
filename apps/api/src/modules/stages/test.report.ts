import { relative } from 'node:path';

export interface TestCounts {
    total: number;
    passed: number;
    failed: number;
    skipped: number; // numPendingTests + numTodoTests
}

/**
 * One failing test, or one test file that failed to even load, as read from the vitest JSON report.
 *
 * `name` is the assertion's `fullName` for an ordinary failed test. It is `undefined` for a file
 * that failed to collect or import — vitest never produced a test name for it, so the first line of
 * its own failure `message` stands in instead.
 */
export interface FailingTest {
    file: string;
    name?: string;
    message?: string;
}

/**
 * `parseTestReport`'s return value: the counts the testing verifier already checked, plus the
 * failing tests behind those counts.
 *
 * `failing` is omitted rather than set to `[]` when there is nothing to report, so a report shaped
 * exactly like the ones this module has always parsed comes back structurally identical to
 * `TestCounts` — nothing downstream that compares the whole return value sees a field it never
 * asked about. A caller that wants the list either way reads `report.failing ?? []`.
 */
export interface TestReport extends TestCounts {
    failing?: FailingTest[];
}

const REQUIRED_FIELDS = ['numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests', 'numTodoTests'] as const;

const firstLine = (message: string): string => message.split('\n', 1)[0] ?? message;

/**
 * The failing tests inside a parsed report's `testResults`, named for the red-suite failure's first
 * line (`redSuiteFailure` in `testing.verifier.ts`) — the one line the board's event log and card
 * 0234's `## Previous attempts` record both keep, so it is the only place a retried stage or a human
 * reading the card learns which test broke.
 *
 * Never throws: `testResults` missing, not an array, or holding an entry with the wrong shape is
 * read as "nothing to name" rather than an error. The counts `parseTestReport` returns alongside
 * this are already the strict, authoritative signal that the report itself is usable — naming
 * failures is a bonus this function is not allowed to jeopardize that on.
 */
const failingTests = (testResults: unknown, worktreePath: string): FailingTest[] => {
    if (!Array.isArray(testResults)) return [];

    const failing: FailingTest[] = [];
    for (const entry of testResults) {
        if (typeof entry !== 'object' || entry === null) continue;
        const result = entry as Record<string, unknown>;

        const name = result.name;
        if (result.status !== 'failed' || typeof name !== 'string') continue;
        const file = relative(worktreePath, name);

        const assertionResults = Array.isArray(result.assertionResults) ? result.assertionResults : [];
        const failedAssertions = assertionResults.filter(
            (a): a is Record<string, unknown> => typeof a === 'object' && a !== null && (a as Record<string, unknown>).status === 'failed',
        );

        if (failedAssertions.length > 0) {
            for (const assertion of failedAssertions) {
                const fullName = assertion.fullName;
                if (typeof fullName === 'string') failing.push({ file, name: fullName });
            }
        } else {
            const message = result.message;
            if (typeof message === 'string' && message.length > 0) {
                failing.push({ file, name: undefined, message: firstLine(message) });
            }
        }
    }
    return failing;
};

/**
 * Parse vitest's JSON reporter output into the counts the testing verifier checks, plus the failing
 * tests (if any) behind those counts.
 *
 * A half-read report must not become a passing check: malformed JSON and missing or non-numeric
 * count fields both throw rather than falling back to a default that would read as zero regressions.
 * The failing-test list is not held to that bar — see `failingTests` above — because naming which
 * test broke is a bonus on top of the counts check, not a replacement for it.
 *
 * `worktreePath` makes each failing file relative to it, the same worktree-relative form the rest of
 * the stage's failures use. It defaults to the empty string — equivalent to the process's own cwd —
 * for a caller that only wants the counts and never reaches a report with failures to name.
 */
export const parseTestReport = (raw: string, worktreePath = ''): TestReport => {
    let data: unknown;
    try {
        data = JSON.parse(raw);
    } catch (err) {
        throw new Error(`test report is not valid JSON: ${(err as Error).message}`, { cause: err });
    }

    if (typeof data !== 'object' || data === null) {
        throw new Error('test report is not a JSON object');
    }

    const record = data as Record<string, unknown>;
    for (const field of REQUIRED_FIELDS) {
        if (typeof record[field] !== 'number') {
            throw new Error(`test report is missing numeric field "${field}"`);
        }
    }

    const numTotalTests = record.numTotalTests as number;
    const numPassedTests = record.numPassedTests as number;
    const numFailedTests = record.numFailedTests as number;
    const numPendingTests = record.numPendingTests as number;
    const numTodoTests = record.numTodoTests as number;

    const failing = failingTests(record.testResults, worktreePath);

    return {
        total: numTotalTests,
        passed: numPassedTests,
        failed: numFailedTests,
        skipped: numPendingTests + numTodoTests,
        ...(failing.length > 0 ? { failing } : {}),
    };
};
