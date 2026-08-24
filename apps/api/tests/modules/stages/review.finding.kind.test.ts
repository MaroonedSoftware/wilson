import { describe, expect, it } from 'vitest';
import { ReviewFindingSchema, ReviewResultSchema } from '#modules/stages/stage.result.js';

/**
 * A finding about work the card did *not* do has no line in the diff to cite — the change was never
 * made. Card 0015's review correctly spotted that a value was never wired into the dispatcher, cited
 * the dispatcher, and had its whole result rejected because that file is not in the diff. It was
 * rejected for the very reason it was right.
 */
describe('review finding kinds', () => {
    const base = { severity: 'blocker' as const, file: 'src/a.ts', problem: 'p', suggestion: 's' };

    it('defaults to defect, so existing reviews are unchanged', () => {
        const parsed = ReviewFindingSchema.parse({ ...base, line: 12 });
        expect(parsed.kind).toBe('defect');
    });

    it('requires a line on a defect', () => {
        const result = ReviewFindingSchema.safeParse(base);
        expect(result.success).toBe(false);
        expect(JSON.stringify(result.error?.issues)).toContain('omission');
    });

    it('accepts an omission with no line', () => {
        expect(ReviewFindingSchema.safeParse({ ...base, kind: 'omission' }).success).toBe(true);
    });

    it('still accepts an omission that happens to carry a line', () => {
        expect(ReviewFindingSchema.safeParse({ ...base, kind: 'omission', line: 3 }).success).toBe(true);
    });

    it('rejects a kind it does not know, rather than treating it as a defect', () => {
        expect(ReviewFindingSchema.safeParse({ ...base, kind: 'nitpick', line: 1 }).success).toBe(false);
    });

    it('carries through a whole result', () => {
        const result = ReviewResultSchema.safeParse({
            summary: 'reviewed',
            verdict: 'revise',
            findings: [
                { ...base, line: 4 },
                { ...base, kind: 'omission', file: 'src/dispatcher.ts' },
            ],
        });
        expect(result.success).toBe(true);
    });
});
