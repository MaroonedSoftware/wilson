import { describe, expect, it } from 'vitest';
import { isRuleFinding, MAX_REVIEW_FINDINGS, ruleFinding, ruleVerdictsMarkdown, withRuleFindings } from '#modules/rules/rule.findings.js';
import type { RuleVerdict } from '#modules/rules/rule.judge.js';
import { ReviewResultSchema, type ReviewFinding, type ReviewResult } from '#modules/stages/stage.result.js';

const verdict = (overrides: Partial<RuleVerdict> = {}): RuleVerdict => ({
    rule: 'no-raw-sql',
    revision: '4',
    statement: 'Queries go through Kysely',
    severity: 'blocker',
    paths: ['src/a.ts'],
    verdict: 'fail',
    file: 'src/a.ts',
    line: 3,
    evidence: 'It builds SQL by hand.',
    reused: false,
    ...overrides,
});

const lines = new Map([['src/a.ts', 5]]);

describe('ruleFinding', () => {
    it('makes a blocker of a failure citing a real line', () => {
        expect(ruleFinding(verdict(), lines)).toMatchObject({ severity: 'blocker', kind: 'defect', file: 'src/a.ts', line: 3 });
    });

    it('starts its text with the rule, so no two rules share it', () => {
        const finding = ruleFinding(verdict(), lines)!;
        expect(finding.problem).toBe('Rule no-raw-sql failed: It builds SQL by hand.');
        expect(isRuleFinding(finding)).toBe(true);
        expect(isRuleFinding({ problem: 'The rule failed: something' })).toBe(false);
    });

    it('makes a concern of a failure with no citation, naming a file the rule was about', () => {
        expect(ruleFinding(verdict({ file: undefined, line: undefined }), lines)).toMatchObject({
            severity: 'concern',
            kind: 'omission',
            file: 'src/a.ts',
        });
    });

    it.each([
        ['past the end of the file', { line: 99 }],
        ['in a file that is gone', { file: 'src/gone.ts' }],
    ])('does not let a citation %s stop a card', (_name, overrides) => {
        expect(ruleFinding(verdict(overrides), lines)).toMatchObject({ severity: 'concern', kind: 'omission', file: 'src/a.ts' });
    });

    it('never makes a blocker of a concern rule, however good the citation', () => {
        expect(ruleFinding(verdict({ severity: 'concern' }), lines)).toMatchObject({ severity: 'concern', kind: 'defect', line: 3 });
    });

    it('has no finding to make when none of the files are there', () => {
        expect(ruleFinding(verdict(), new Map())).toBeUndefined();
    });

    it("keeps a spaced dash out of the problem, where one marks the suggestion's start on a plan", () => {
        expect(ruleFinding(verdict({ evidence: 'It builds SQL — by hand.' }), lines)?.problem).toBe(
            'Rule no-raw-sql failed: It builds SQL; by hand.',
        );
    });

    it('makes a finding the review schema accepts', () => {
        const report = { summary: 's', verdict: 'revise', findings: [ruleFinding(verdict(), lines)] };
        expect(ReviewResultSchema.safeParse(report).success).toBe(true);
    });
});

describe('withRuleFindings', () => {
    const finding = (severity: 'blocker' | 'concern', problem: string): ReviewFinding => ({
        severity,
        kind: 'defect',
        file: 'src/a.ts',
        line: 1,
        problem,
        suggestion: 'fix it',
    });
    const report = (findings: ReviewFinding[], verdict: 'pass' | 'revise' = 'pass'): ReviewResult => ({
        summary: 'Reviewed.',
        verdict,
        findings,
        criteria: [],
    });
    const problems = (result: ReviewResult) => result.findings.map(item => item.problem);

    it('forces revise for a rule blocker, whatever the review said', () => {
        const merged = withRuleFindings(report([finding('concern', 'review concern')]), [finding('blocker', 'rule blocker')]);

        expect(merged.verdict).toBe('revise');
        expect(problems(merged)).toEqual(['rule blocker', 'review concern']);
        expect(merged.summary).toBe('Reviewed. A checked rule also failed.');
    });

    it("leaves the review's verdict alone for a rule concern", () => {
        const merged = withRuleFindings(report([]), [finding('concern', 'rule concern')]);

        expect(merged.verdict).toBe('pass');
        expect(merged.summary).toBe('Reviewed.');
        expect(problems(merged)).toEqual(['rule concern']);
    });

    it('does not turn a revise into a pass', () => {
        expect(withRuleFindings(report([finding('blocker', 'review blocker')], 'revise'), [finding('concern', 'rule')]).verdict).toBe('revise');
    });

    it('returns the report untouched with nothing to add', () => {
        const original = report([finding('blocker', 'x')], 'revise');
        expect(withRuleFindings(original, [])).toBe(original);
    });

    it("drops the review's concerns first at the cap, then the rules' concerns, and keeps every blocker", () => {
        const reviewConcerns = Array.from({ length: 15 }, (_, i) => finding('concern', `review concern ${i}`));
        const reviewBlockers = Array.from({ length: 4 }, (_, i) => finding('blocker', `review blocker ${i}`));
        const ruleFindings = [finding('blocker', 'rule blocker'), finding('concern', 'rule concern 1'), finding('concern', 'rule concern 2')];

        const merged = withRuleFindings(report([...reviewConcerns, ...reviewBlockers], 'revise'), ruleFindings);

        expect(merged.findings).toHaveLength(MAX_REVIEW_FINDINGS);
        expect(problems(merged).slice(0, 8)).toEqual([
            'rule blocker',
            'review blocker 0',
            'review blocker 1',
            'review blocker 2',
            'review blocker 3',
            'rule concern 1',
            'rule concern 2',
            'review concern 0',
        ]);
        expect(ReviewResultSchema.safeParse(merged).success).toBe(true);
    });
});

describe('ruleVerdictsMarkdown', () => {
    it('says what each rule came to, and that the reviewer need not', () => {
        const text = ruleVerdictsMarkdown([
            verdict(),
            verdict({ rule: 'other', verdict: 'pass' }),
            verdict({ rule: 'third', verdict: 'unavailable', evidence: 'engine\ndown' }),
        ]);

        expect(text).toContain('do not judge these rules again');
        expect(text).toContain('**no-raw-sql**: failed at src/a.ts:3. It builds SQL by hand.');
        expect(text).toContain('**other**: passed.');
        expect(text).toContain('**third**: no verdict, so it stops nothing (engine down).');
    });

    it('is empty with no verdicts', () => {
        expect(ruleVerdictsMarkdown([])).toBe('');
    });
});
