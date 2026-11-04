import type { Rule } from './rule.store.js';

/**
 * A project's rules as a section of the guidance a stage reads, so the work can meet them before a
 * judge looks. Empty when there are none, so a project with no rules reads what it read before.
 */
export const rulesGuidance = (rules: readonly Rule[]): string => {
    if (rules.length === 0) return '';
    return [
        '## Checked rules',
        '',
        'A person set these rules for this project. At review, an independent judge checks each rule against the diff of the files it names, and a failure can send the card back.',
        '',
        ...rules.map(rule => `- **${rule.id}** (${rule.severity}, in ${rule.paths.map(path => `\`${path}\``).join(', ')}): ${rule.statement}`),
    ].join('\n');
};

/** The learnings document with the rules after it, either of which may be empty. */
export const withRulesGuidance = (learnings: string, rules: readonly Rule[]): string =>
    [learnings.trim().length > 0 ? learnings : '', rulesGuidance(rules)].filter(part => part.length > 0).join('\n\n');
