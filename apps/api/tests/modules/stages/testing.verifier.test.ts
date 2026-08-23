import { describe, expect, it } from 'vitest';
import { baselineProvesChange, checkCounts } from '#modules/stages/testing.verifier.js';
import { parseTestReport } from '#modules/stages/test.report.js';

describe('parseTestReport', () => {
    it('reads a valid vitest JSON report', () => {
        const raw = JSON.stringify({
            numTotalTests: 10,
            numPassedTests: 8,
            numFailedTests: 0,
            numPendingTests: 1,
            numTodoTests: 1,
        });

        expect(parseTestReport(raw)).toEqual({ total: 10, passed: 8, failed: 0, skipped: 2 });
    });

    it('throws on malformed JSON', () => {
        expect(() => parseTestReport('{ not json')).toThrow(/not valid JSON/);
    });

    it('throws when a required numeric field is missing', () => {
        const raw = JSON.stringify({
            numTotalTests: 10,
            numPassedTests: 10,
            numFailedTests: 0,
            numPendingTests: 0,
            // numTodoTests missing
        });

        expect(() => parseTestReport(raw)).toThrow(/numTodoTests/);
    });

    it('throws when a field is present but not a number', () => {
        const raw = JSON.stringify({
            numTotalTests: '10',
            numPassedTests: 10,
            numFailedTests: 0,
            numPendingTests: 0,
            numTodoTests: 0,
        });

        expect(() => parseTestReport(raw)).toThrow(/numTotalTests/);
    });
});

describe('checkCounts', () => {
    const counts = { total: 10, passed: 10, failed: 0, skipped: 0 };

    it('passes when counts equal the baseline', () => {
        expect(checkCounts(counts, { total: 10, skipped: 0 })).toEqual([]);
    });

    it('fails when the total dropped', () => {
        const failures = checkCounts(counts, { total: 12, skipped: 0 });
        expect(failures).toHaveLength(1);
        expect(failures[0]).toMatch(/dropped from 12 to 10/);
    });

    it('fails when the skipped count rose', () => {
        const failures = checkCounts({ ...counts, skipped: 3 }, { total: 10, skipped: 1 });
        expect(failures).toHaveLength(1);
        expect(failures[0]).toMatch(/rose from 1 to 3/);
    });

    it('skips both checks without failing when baselineCounts is absent', () => {
        expect(checkCounts(counts, undefined)).toEqual([]);
        expect(checkCounts({ ...counts, total: 0, skipped: 100 }, undefined)).toEqual([]);
    });
});

describe('baselineProvesChange', () => {
    it('passes when the baseline run had at least one failure', () => {
        expect(baselineProvesChange({ total: 1, passed: 0, failed: 1, skipped: 0 }, false)).toBe(true);
    });

    it('fails when the baseline run had zero failures', () => {
        expect(baselineProvesChange({ total: 1, passed: 1, failed: 0, skipped: 0 }, false)).toBe(false);
    });

    it('passes on a non-zero exit with no parseable report — a test that fails to even import', () => {
        expect(baselineProvesChange(undefined, true)).toBe(true);
    });

    it('fails on a zero exit with no parseable report', () => {
        expect(baselineProvesChange(undefined, false)).toBe(false);
    });
});
