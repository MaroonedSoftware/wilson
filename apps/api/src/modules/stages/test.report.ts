export interface TestCounts {
    total: number;
    passed: number;
    failed: number;
    skipped: number; // numPendingTests + numTodoTests
}

const REQUIRED_FIELDS = ['numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests', 'numTodoTests'] as const;

/**
 * Parse vitest's JSON reporter output into the counts the testing verifier checks.
 *
 * A half-read report must not become a passing check: malformed JSON and missing or non-numeric
 * fields both throw rather than falling back to a default that would read as zero regressions.
 */
export const parseTestReport = (raw: string): TestCounts => {
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

    return {
        total: numTotalTests,
        passed: numPassedTests,
        failed: numFailedTests,
        skipped: numPendingTests + numTodoTests,
    };
};
