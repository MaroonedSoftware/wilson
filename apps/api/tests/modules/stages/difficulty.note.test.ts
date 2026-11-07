import { describe, expect, it } from 'vitest';
import { DIFFICULTY_LIMIT, difficultyOf, ImplementingResultSchema, ReviewResultSchema } from '#modules/stages/stage.result.js';

describe('difficulty note', () => {
    it('is optional on both report schemas, so a report without one still parses', () => {
        expect(ImplementingResultSchema.safeParse({ summary: 's', filesTouched: [] }).success).toBe(true);
        expect(ReviewResultSchema.safeParse({ summary: 's', verdict: 'pass', findings: [] }).success).toBe(true);
    });

    it('is kept when a stage gives one', () => {
        const parsed = ImplementingResultSchema.parse({ summary: 's', filesTouched: [], difficulty: 'the dispatcher has no seam for a fake clock' });
        expect(difficultyOf(parsed)).toBe('the dispatcher has no seam for a fake clock');
    });

    it('folds whitespace into one line and trims it to the limit, never refusing it', () => {
        expect(difficultyOf({ difficulty: '  slow\n\n  suite  ' })).toBe('slow suite');
        expect(difficultyOf({ difficulty: 'x'.repeat(DIFFICULTY_LIMIT + 50) })).toHaveLength(DIFFICULTY_LIMIT);
    });

    it('reads nothing from a blank note, a non-string or no result', () => {
        expect(difficultyOf({ difficulty: '   ' })).toBeUndefined();
        expect(difficultyOf({ difficulty: 3 })).toBeUndefined();
        expect(difficultyOf(undefined)).toBeUndefined();
    });
});
