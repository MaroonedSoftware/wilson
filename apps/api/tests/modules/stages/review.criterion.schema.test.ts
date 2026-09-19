import { describe, expect, it } from 'vitest';
import { ReviewCriterionSchema, ReviewResultSchema } from '#modules/stages/stage.result.js';

/**
 * Card 0236: `ReviewResultSchema.criteria` defaults to `[]` so a plan with no acceptance criteria
 * bullets, and a result reported before this field existed, both still parse — `ReviewVerifier`
 * skips its whole criteria-accounting block on an empty plan-side list either way
 * (`review.verifier.test.ts` exercises that). This file is the schema-level half: what
 * `ReviewCriterionSchema`/`ReviewResultSchema` accept and reject on their own, independent of the
 * runner's provenance checks.
 */
describe('ReviewCriterionSchema', () => {
    const met = { id: 'AC1', status: 'met' as const, file: 'src/a.ts', line: 3, note: 'implemented' };

    it('accepts a "met" criterion that carries file and line', () => {
        expect(ReviewCriterionSchema.safeParse(met).success).toBe(true);
    });

    it('rejects a "met" criterion missing file', () => {
        const { file: _file, ...rest } = met;
        expect(ReviewCriterionSchema.safeParse(rest).success).toBe(false);
    });

    it('rejects a "met" criterion missing line', () => {
        const { line: _line, ...rest } = met;
        expect(ReviewCriterionSchema.safeParse(rest).success).toBe(false);
    });

    it('accepts an "unmet" criterion with neither file nor line', () => {
        expect(ReviewCriterionSchema.safeParse({ id: 'AC1', status: 'unmet', note: 'not done' }).success).toBe(true);
    });

    it('accepts an "unverifiable" criterion with neither file nor line', () => {
        expect(ReviewCriterionSchema.safeParse({ id: 'AC1', status: 'unverifiable', note: 'cannot check from the diff' }).success).toBe(true);
    });

    it('rejects a status it does not know', () => {
        expect(ReviewCriterionSchema.safeParse({ id: 'AC1', status: 'skipped', note: 'x' }).success).toBe(false);
    });

    it('rejects a criterion with no note', () => {
        const { note: _note, ...rest } = met;
        expect(ReviewCriterionSchema.safeParse(rest).success).toBe(false);
    });
});

describe('ReviewResultSchema.criteria', () => {
    const base = { summary: 'reviewed', verdict: 'pass' as const, findings: [] };

    it('defaults to an empty array when the field is entirely absent', () => {
        const parsed = ReviewResultSchema.parse(base);
        expect(parsed.criteria).toEqual([]);
    });

    it('parses a result reported before this field existed, exactly as it did before', () => {
        const result = ReviewResultSchema.safeParse(base);
        expect(result.success).toBe(true);
    });

    it('carries through an explicit criteria array', () => {
        const parsed = ReviewResultSchema.parse({
            ...base,
            criteria: [{ id: 'AC1', status: 'met', file: 'src/a.ts', line: 1, note: 'done' }],
        });
        expect(parsed.criteria).toEqual([{ id: 'AC1', status: 'met', file: 'src/a.ts', line: 1, note: 'done' }]);
    });

    it('rejects a result whose criteria array contains an invalid criterion', () => {
        const result = ReviewResultSchema.safeParse({ ...base, criteria: [{ id: 'AC1', status: 'met', note: 'missing file/line' }] });
        expect(result.success).toBe(false);
    });
});
