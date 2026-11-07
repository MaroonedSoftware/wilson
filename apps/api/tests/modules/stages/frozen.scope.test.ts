import { describe, expect, it } from 'vitest';
import { earlierFindings, withFindings } from '#modules/board/append.findings.js';
import type { Card } from '#modules/board/card.js';
import { DEMOTED_PREFIX, isLaterReview, withFrozenScope } from '#modules/stages/frozen.scope.js';
import { planMaterial } from '#modules/stages/stage.preparation.js';
import { StageConfigSchema, type ProjectStages } from '#modules/stages/stage.config.js';
import type { ReviewFinding, ReviewResult } from '#modules/stages/stage.result.js';

const PLAN = '## Goal\n\nDo the thing.\n\n## Files in scope\n\n- src/a.ts\n';

const cardWith = (body: string): Card => ({
    frontmatter: { id: '0001', title: 'thing', stage: 'review', dependsOn: [], retries: {} },
    sections: { 'Files in scope': '- src/a.ts' },
    body,
});

const blocker = (file: string, problem: string, fields: Partial<ReviewFinding> = {}): ReviewFinding => ({
    severity: 'blocker',
    kind: 'defect',
    file,
    line: 1,
    problem,
    suggestion: 'fix it',
    ...fields,
});

const firstRound = cardWith(withFindings(PLAN, [blocker('src/a.ts', 'a is wrong'), { ...blocker('src/b.ts', 'b is ugly'), severity: 'concern' }]));

const report = (findings: ReviewFinding[], fields: Partial<ReviewResult> = {}): ReviewResult => ({
    summary: 's',
    verdict: findings.some(finding => finding.severity === 'blocker') ? 'revise' : 'pass',
    findings,
    criteria: [],
    ...fields,
});

describe('earlierFindings', () => {
    it('reads back what withFindings wrote, an omission with no line included', () => {
        const body = withFindings(PLAN, [
            blocker('src/a.ts', 'x'),
            { ...blocker('src/c.ts', 'y'), kind: 'omission', line: undefined, severity: 'concern' },
        ]);
        expect(earlierFindings(body)).toEqual([
            { severity: 'blocker', file: 'src/a.ts' },
            { severity: 'concern', file: 'src/c.ts' },
        ]);
    });

    it('is empty for a plan no review has written on', () => {
        expect(earlierFindings(PLAN)).toEqual([]);
    });
});

describe('withFrozenScope', () => {
    it('leaves a first review alone, however many new blockers it raises', () => {
        const result = report([blocker('src/z.ts', 'new')]);
        expect(withFrozenScope(result, cardWith(PLAN))).toEqual({ result, demoted: [] });
        expect(isLaterReview(cardWith(PLAN))).toBe(false);
    });

    it('treats a card whose earlier review raised only concerns as still on its first round', () => {
        const onlyConcerns = cardWith(withFindings(PLAN, [{ ...blocker('src/a.ts', 'x'), severity: 'concern' }]));
        const result = report([blocker('src/z.ts', 'new')]);
        expect(withFrozenScope(result, onlyConcerns).demoted).toEqual([]);
    });

    it('turns a later blocker with no basis into a concern, and a revise left with nothing into a pass', () => {
        const { result, demoted } = withFrozenScope(report([blocker('src/z.ts', 'something new')]), firstRound);

        expect(isLaterReview(firstRound)).toBe(true);
        expect(demoted).toEqual(['something new']);
        expect(result).toMatchObject({
            verdict: 'pass',
            findings: [{ severity: 'concern', problem: `${DEMOTED_PREFIX}something new`, file: 'src/z.ts' }],
        });
    });

    it('keeps a blocker that gives regression, criterion or safety as its reason', () => {
        const findings = [
            blocker('src/z.ts', 'broke the cache', { basis: 'regression' }),
            blocker('src/z.ts', 'AC2 still unmet', { basis: 'criterion' }),
            blocker('src/z.ts', 'logs the token', { basis: 'safety' }),
        ];
        const { result, demoted } = withFrozenScope(report(findings), firstRound);

        expect(demoted).toEqual([]);
        expect((result as ReviewResult).findings.every(finding => finding.severity === 'blocker')).toBe(true);
    });

    it('keeps "unfixed" only on a file an earlier blocker named, and not on one only a concern named', () => {
        const { result, demoted } = withFrozenScope(
            report([blocker('src/a.ts', 'a still wrong', { basis: 'unfixed' }), blocker('src/b.ts', 'b still ugly', { basis: 'unfixed' })]),
            firstRound,
        );

        expect(demoted).toEqual(['b still ugly']);
        expect(result).toMatchObject({ verdict: 'revise', findings: [{ severity: 'blocker' }, { severity: 'concern' }] });
    });

    it('always keeps a rule’s own blocker, since a person stated the rule', () => {
        const { demoted } = withFrozenScope(report([blocker('src/z.ts', 'Rule no-logs failed: logs a token')]), firstRound);
        expect(demoted).toEqual([]);
    });

    it('stays a revise when an unmet criterion is left, even with every blocker demoted', () => {
        const { result } = withFrozenScope(
            report([blocker('src/z.ts', 'new')], { criteria: [{ id: 'AC1', status: 'unmet', note: 'not done' }] }),
            firstRound,
        );
        expect((result as ReviewResult).verdict).toBe('revise');
    });

    it('leaves a report that does not parse for the verifier to reject', () => {
        const garbage = { verdict: 'maybe' };
        expect(withFrozenScope(garbage, firstRound)).toEqual({ result: garbage, demoted: [] });
    });
});

describe('the later-review note on the plan', () => {
    const stages = { stages: [] } as unknown as ProjectStages;
    const review = StageConfigSchema.parse({ name: 'review', mode: 'agent', model: 'm', instructions: 'i', onPass: 'ready', onFail: 'implementing' });

    it('tells a later review the four reasons a blocker may still give', () => {
        const text = planMaterial(firstRound, stages, review);
        expect(text).toContain('## This is a later review');
        expect(text).toContain('`unfixed`');
    });

    it('is not on a first review, a step, or another lane', () => {
        expect(planMaterial(cardWith(PLAN), stages, review)).not.toContain('later review');
        expect(planMaterial(firstRound, stages, { ...review, step: 'challenge', verifier: 'challenge' })).not.toContain('later review');
        expect(planMaterial(firstRound, stages, { ...review, name: 'implementing' })).not.toContain('later review');
    });
});
