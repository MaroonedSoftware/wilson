import { describe, expect, it } from 'vitest';
import { rulesGuidance, withRulesGuidance } from '#modules/rules/rule.guidance.js';
import { StaticRuleStore } from '#modules/rules/rule.store.js';

const someRules = async () => {
    const rules = new StaticRuleStore();
    await rules.create('no-raw-sql', { statement: 'Queries go through Kysely', paths: ['src/**', 'lib/**'], severity: 'blocker' }, 'x');
    return rules.list();
};

describe('rulesGuidance', () => {
    it('names each rule, its severity, its paths and what it says', async () => {
        const text = rulesGuidance(await someRules());

        expect(text).toContain('## Checked rules');
        expect(text).toContain('**no-raw-sql** (blocker, in `src/**`, `lib/**`): Queries go through Kysely');
    });

    it('is empty with no rules', () => {
        expect(rulesGuidance([])).toBe('');
    });
});

describe('withRulesGuidance', () => {
    it('leaves the learnings as they are when there are no rules', () => {
        expect(withRulesGuidance('# Lessons\n', [])).toBe('# Lessons\n');
    });

    it('is the rules alone when there are no learnings', async () => {
        const rules = await someRules();
        expect(withRulesGuidance('  \n', rules)).toBe(rulesGuidance(rules));
    });

    it('puts the rules after the learnings', async () => {
        const text = withRulesGuidance('# Lessons', await someRules());
        expect(text.indexOf('# Lessons')).toBeLessThan(text.indexOf('## Checked rules'));
    });

    it('is empty when both are', () => {
        expect(withRulesGuidance('', [])).toBe('');
    });
});
