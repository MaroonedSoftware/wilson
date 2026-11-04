import { describe, expect, it } from 'vitest';
import {
    buildReport,
    FINDINGS_CAP,
    formatReport,
    rawView,
    scoreCase,
    verifiedView,
    type ReviewEvalLabel,
    type ReviewEvalRun,
    type ReviewEvalTruth,
} from '#modules/evals/review.eval.score.js';
import { ReviewResultSchema, type ReviewFinding } from '#modules/stages/stage.result.js';

const defect: ReviewEvalTruth = {
    kind: 'defect',
    class: 'concurrency',
    file: 'src/a.ts',
    lines: [10, 12],
    about: 'a race',
    fixedBy: 'f'.repeat(40),
};
const control: ReviewEvalTruth = { kind: 'control', about: 'no later fix' };

const finding = (over: Partial<ReviewFinding> = {}): ReviewFinding => ({
    severity: 'blocker',
    kind: 'defect',
    file: 'src/a.ts',
    line: 11,
    problem: 'p',
    suggestion: 's',
    ...over,
});
const result = (findings: ReviewFinding[], verdict: 'pass' | 'revise' = findings.some(f => f.severity === 'blocker') ? 'revise' : 'pass') => ({
    summary: 's',
    verdict,
    findings,
    criteria: [],
});
const passed = { passed: true, failures: [], changedPaths: ['src/a.ts'] };

const label: ReviewEvalLabel = { model: 'm', engine: 'cli 1', promptRevision: 'r7', promptSha256: 'a'.repeat(64), corpusCommit: 'b'.repeat(40) };

describe('rawView and verifiedView', () => {
    it('reads a result that does not parse as rejected', () => {
        expect(rawView({ nonsense: true })).toEqual({ rejected: true, findings: [] });
    });

    it('takes every finding at face value in the raw view, whatever the verifier said', () => {
        const reported = result([finding()]);
        expect(rawView(reported).findings).toHaveLength(1);
        expect(verifiedView(reported, { ...passed, passed: false, failures: ['no'] })).toEqual({ rejected: true, findings: [] });
    });

    it('rejects a result the verifier never saw', () => {
        expect(verifiedView(result([finding()]), undefined).rejected).toBe(true);
    });

    it('relabels a defect outside the diff as an omission, as the verifier treats it', () => {
        const outside = finding({ file: 'src/b.ts' });
        expect(verifiedView(result([outside]), passed).findings[0]?.kind).toBe('omission');
        expect(rawView(result([outside])).findings[0]?.kind).toBe('defect');
    });
});

describe('scoreCase on a defect', () => {
    const score = (findings: ReviewFinding[]) => scoreCase('c', defect, rawView(result(findings)));

    it('counts a blocker inside the range as caught and blocked, at both ends', () => {
        for (const line of [10, 12]) {
            expect(score([finding({ line })])).toMatchObject({ caught: true, blocked: true, otherBlockers: 0 });
        }
    });

    it('misses a finding just outside the range', () => {
        for (const line of [9, 13]) {
            expect(score([finding({ line })])).toMatchObject({ caught: false, blocked: false, otherBlockers: 1 });
        }
    });

    it('counts a concern at the defect as caught but not blocked', () => {
        expect(score([finding({ severity: 'concern' })])).toMatchObject({ caught: true, blocked: false });
    });

    it('prefers the blocker as the match when a concern is also there', () => {
        const concern = finding({ severity: 'concern', problem: 'concern' });
        const blocker = finding({ problem: 'blocker' });
        expect(score([concern, blocker])).toMatchObject({ blocked: true, match: { problem: 'blocker' } });
    });

    it('matches an omission on its file alone, since it cites no line', () => {
        expect(score([finding({ kind: 'omission', line: undefined })])).toMatchObject({ caught: true });
        expect(score([finding({ kind: 'omission', line: undefined, file: 'src/b.ts' })])).toMatchObject({ caught: false });
    });

    it('accepts a leading ./ on the cited path', () => {
        expect(score([finding({ file: './src/a.ts' })])).toMatchObject({ caught: true });
    });

    it('scores a rejected result as a miss', () => {
        expect(scoreCase('c', defect, verifiedView(result([finding()]), { ...passed, passed: false }))).toMatchObject({
            rejected: true,
            caught: false,
        });
    });

    it('raw and verified can disagree over a relabelled finding', () => {
        const truth: ReviewEvalTruth = { ...defect, file: 'src/b.ts' };
        const reported = result([finding({ file: 'src/b.ts', line: 500 })]);
        expect(scoreCase('c', truth, rawView(reported))).toMatchObject({ caught: false });
        expect(scoreCase('c', truth, verifiedView(reported, passed))).toMatchObject({ caught: true });
    });
});

describe('scoreCase on a control', () => {
    it('is clean when it passes with no blocker, concerns allowed', () => {
        expect(scoreCase('c', control, rawView(result([finding({ severity: 'concern' })])))).toMatchObject({ clean: true, concerns: 1 });
    });

    it('is not clean with a blocker or a revise', () => {
        expect(scoreCase('c', control, rawView(result([finding()])))).toMatchObject({ clean: false, blockers: 1 });
        expect(scoreCase('c', control, rawView(result([], 'revise')))).toMatchObject({ clean: false });
    });

    it('is not clean when the verifier refused it', () => {
        expect(scoreCase('c', control, verifiedView(result([]), { ...passed, passed: false }))).toMatchObject({ clean: false, rejected: true });
    });
});

describe('the findings cap', () => {
    it('is the schema limit, and a review at it is flagged', () => {
        const atCap = Array.from({ length: FINDINGS_CAP }, () => finding({ severity: 'concern', line: 99 }));
        expect(ReviewResultSchema.safeParse(result(atCap)).success).toBe(true);
        expect(ReviewResultSchema.safeParse(result([...atCap, finding({ severity: 'concern' })])).success).toBe(false);
        expect(scoreCase('c', control, rawView(result(atCap)))).toMatchObject({ atFindingsCap: true });
    });
});

describe('buildReport', () => {
    const runs: ReviewEvalRun[] = [
        { caseId: 'hit', truth: defect, reported: result([finding()]), verification: passed },
        { caseId: 'near', truth: { ...defect, class: 'logic' }, reported: result([finding({ severity: 'concern' })]), verification: passed },
        { caseId: 'refused', truth: { ...defect, class: 'logic' }, reported: result([finding()]), verification: { ...passed, passed: false } },
        { caseId: 'clean', truth: control, reported: result([]), verification: passed },
        { caseId: 'noisy', truth: control, reported: result([finding()]), verification: passed },
        { caseId: 'dead', truth: defect, unscored: 'the engine failed' },
    ];
    const report = buildReport(label, '2026-11-04T00:00:00.000Z', runs);

    it('reports recall and specificity with n, leaving the unscored out of it', () => {
        expect(report.raw.summary.recall).toEqual({ caught: 3, blocked: 2, n: 3 });
        expect(report.verified.summary.recall).toEqual({ caught: 2, blocked: 1, n: 3 });
        expect(report.raw.summary.specificity).toEqual({ clean: 1, n: 2 });
        expect(report.unscored).toEqual([{ caseId: 'dead', reason: 'the engine failed' }]);
    });

    it('breaks recall down by class and counts rejections', () => {
        expect(report.verified.summary.recallByClass).toEqual({
            concurrency: { caught: 1, blocked: 1, n: 1 },
            logic: { caught: 1, blocked: 0, n: 2 },
        });
        expect(report.verified.summary.rejected).toBe(1);
        expect(report.raw.summary.rejected).toBe(0);
    });

    it('says what it measured, n, and that review-only scores overstate what survives challenge', () => {
        const text = formatReport(report);
        expect(text).toContain('Model m on cli 1, prompt r7');
        expect(text).toContain('overstate what would reach a kickback');
        expect(text).toContain('Recall, a blocker at the defect: 2/3 (67%)');
        expect(text).toContain('Specificity, a clean diff passed with no blocker: 1/2 (50%)');
        expect(text).toContain('- dead: the engine failed');
    });

    it('does not divide by zero on an empty run', () => {
        expect(formatReport(buildReport(label, 't', []))).toContain('no cases');
    });
});
