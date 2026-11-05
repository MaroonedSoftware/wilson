import { describe, expect, it } from 'vitest';
import { expectedAssertionDrop } from '#modules/board/card.js';
import type { Card } from '#modules/board/card.js';

const card = (raw: string | undefined, section = 'Constraints'): Card => ({
    frontmatter: { id: '0001', title: 'thing', stage: 'planning', dependsOn: [], retries: {} },
    sections: raw === undefined ? {} : { [section]: raw },
    body: '',
});

describe('expectedAssertionDrop', () => {
    it('returns the declared number', () => {
        expect(expectedAssertionDrop(card('- Expected assertion drop: 6 (the probe suite is retired)'))).toBe(6);
    });

    it('matches the label case-insensitively and through code backticks', () => {
        expect(expectedAssertionDrop(card('- expected ASSERTION Drop: 3 (reason)'))).toBe(3);
        expect(expectedAssertionDrop(card('- `Expected assertion drop: 3 (reason)`'))).toBe(3);
    });

    it('finds the bullet among others, and uses the first of two', () => {
        expect(expectedAssertionDrop(card('- other\n- Expected assertion drop: 2 (a)\n- Expected assertion drop: 9 (b)'))).toBe(2);
    });

    it.each([
        ['no section', undefined],
        ['no such bullet', '- some other constraint'],
        ['zero', '- Expected assertion drop: 0 (nothing)'],
        ['not a number', '- Expected assertion drop: many (reasons)'],
        ['no reason', '- Expected assertion drop: 3'],
        ['an empty reason', '- Expected assertion drop: 3 ( )'],
        ['the skipped-test declaration', '- Expected skipped tests: 3 (reason)'],
        ['a mention mid-sentence', '- This has no Expected assertion drop: 3 (reason)'],
    ])('gives no allowance for %s', (_, raw) => {
        expect(expectedAssertionDrop(card(raw))).toBeUndefined();
    });

    it('reads only Constraints, so a stage’s own account of its work grants nothing', () => {
        expect(expectedAssertionDrop(card('- Expected assertion drop: 3 (reason)', 'Caveats'))).toBeUndefined();
    });
});
