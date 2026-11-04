import { describe, expect, it } from 'vitest';
import { axisTop, compactTokens, passedOutright, percentOf, revisedCount } from '../src/lib/stats.js';

describe('axisTop', () => {
    it.each([
        [0, 1],
        [1, 1],
        [3, 5],
        [18, 20],
        [21, 25],
        [26, 50],
        [1200, 2000],
        [1_000_000, 1_000_000],
        [6_000_000, 10_000_000],
    ])('takes %i to %i', (max, top) => {
        expect(axisTop(max)).toBe(top);
    });
});

describe('percentOf', () => {
    it('rounds to a whole percentage', () => {
        expect(percentOf(1, 3)).toBe(33);
    });

    it('has no answer for a share of nothing', () => {
        expect(percentOf(0, 0)).toBeUndefined();
    });
});

describe('compactTokens', () => {
    it('shortens from a thousand up', () => {
        expect(compactTokens(950)).toBe('950');
        expect(compactTokens(1_234_567)).toBe('1.2M');
    });
});

describe('passedOutright', () => {
    it('takes a revise out of the passes', () => {
        expect(passedOutright(3, 1)).toBe(2);
    });

    it('does not go below zero when the two figures were read a moment apart', () => {
        expect(passedOutright(1, 2)).toBe(0);
    });
});

describe('revisedCount', () => {
    const revised = [
        { stage: 'review', count: 2 },
        { stage: 'plan-review', count: 1 },
    ];

    it('sums every stage, or one', () => {
        expect(revisedCount(revised)).toBe(3);
        expect(revisedCount(revised, 'review')).toBe(2);
        expect(revisedCount(revised, 'testing')).toBe(0);
    });
});
