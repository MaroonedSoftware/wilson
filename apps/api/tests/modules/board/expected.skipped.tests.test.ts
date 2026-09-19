import { describe, expect, it } from 'vitest';
import { expectedSkippedTests } from '#modules/board/card.js';
import type { Card } from '#modules/board/card.js';

/**
 * Card 0232: a plan can declare the skipped tests it expects via a `Constraints` bullet
 * `Expected skipped tests: N`, so `TestingVerifier.checkCounts` (testing.verifier.test.ts) can let
 * a skip the plan named on purpose through, instead of failing every rise in the skipped count the
 * way it did for card 0231's deliberately skipped suite. This file drives `expectedSkippedTests`
 * directly, the same way `acceptance.criteria.test.ts` drives its sibling `acceptanceCriteria`.
 */
const card = (raw: string | undefined): Card => ({
    frontmatter: { id: '0001', title: 'thing', stage: 'planning', dependsOn: [], retries: {} },
    sections: raw === undefined ? {} : { Constraints: raw },
    body: '',
});

describe('expectedSkippedTests', () => {
    it('AC1: returns the declared number for a bullet with a reason in parentheses', () => {
        expect(expectedSkippedTests(card('- Expected skipped tests: 6 (engine probes)'))).toBe(6);
    });

    it('AC1: returns undefined when the Constraints section is absent', () => {
        expect(expectedSkippedTests(card(undefined))).toBeUndefined();
    });

    it('AC1: returns undefined when Constraints is present but has no such bullet', () => {
        expect(expectedSkippedTests(card('- some other constraint entirely'))).toBeUndefined();
    });

    it('AC1: returns undefined for a declared value of 0', () => {
        expect(expectedSkippedTests(card('- Expected skipped tests: 0'))).toBeUndefined();
    });

    it('AC1: returns undefined for a non-number value', () => {
        expect(expectedSkippedTests(card('- Expected skipped tests: many'))).toBeUndefined();
    });

    it('matches the label case-insensitively', () => {
        expect(expectedSkippedTests(card('- expected SKIPPED Tests: 3'))).toBe(3);
    });

    it('reads a bullet with no reason at all', () => {
        expect(expectedSkippedTests(card('- Expected skipped tests: 4'))).toBe(4);
    });

    it('uses the first declaration when more than one bullet declares it', () => {
        const raw = '- Expected skipped tests: 6 (first)\n- Expected skipped tests: 9 (second)';
        expect(expectedSkippedTests(card(raw))).toBe(6);
    });

    it('ignores a declaration outside the Constraints section', () => {
        const withDeclaration: Card = {
            frontmatter: { id: '0001', title: 'thing', stage: 'planning', dependsOn: [], retries: {} },
            sections: { 'Acceptance criteria': '- Expected skipped tests: 6' },
            body: '',
        };
        expect(expectedSkippedTests(withDeclaration)).toBeUndefined();
    });

    it('strips the bullet marker and inline code backticks the same way filesInScope does', () => {
        expect(expectedSkippedTests(card('* `Expected skipped tests: 5`'))).toBe(5);
    });
});
