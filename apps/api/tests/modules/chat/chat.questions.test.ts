import { describe, expect, it } from 'vitest';
import { describeAnswers, validateAnswers, type AskedQuestion } from '#modules/chat/chat.questions.js';

const database: AskedQuestion = {
    header: 'Database',
    text: 'Which database should this project use?',
    options: [
        { label: 'Postgres', description: 'The default for this repo.' },
        { label: 'SQLite', description: 'Simpler, file-based.' },
    ],
    multiSelect: false,
};

const features: AskedQuestion = {
    header: 'Features',
    text: 'Which features should the first cut include?',
    options: [
        { label: 'Auth', description: 'Sign-in.' },
        { label: 'Billing', description: 'Payments.' },
        { label: 'Search', description: 'Full-text search.' },
    ],
    multiSelect: true,
};

describe('validateAnswers', () => {
    it('accepts one answer per question, chosen by index', () => {
        expect(validateAnswers([database, features], [{ chosen: [0] }, { chosen: [0, 2] }])).toBeUndefined();
    });

    it('accepts an answer given only as "Other" text', () => {
        expect(validateAnswers([database], [{ chosen: [], other: 'MySQL' }])).toBeUndefined();
    });

    it('rejects the wrong number of answers', () => {
        expect(validateAnswers([database, features], [{ chosen: [0] }])).toContain('expected 2 answer(s), got 1');
    });

    it('rejects a chosen index out of range', () => {
        expect(validateAnswers([database], [{ chosen: [5] }])).toContain('does not exist');
    });

    it('rejects a chosen index repeated', () => {
        expect(validateAnswers([features], [{ chosen: [0, 0] }])).toContain('chose the same option twice');
    });

    it('rejects more than one choice on a question that is not multiSelect', () => {
        expect(validateAnswers([database], [{ chosen: [0, 1] }])).toContain('allows only one choice');
    });

    it('rejects a question left with neither a choice nor "Other" text', () => {
        expect(validateAnswers([database], [{ chosen: [] }])).toContain('was left unanswered');
        expect(validateAnswers([database], [{ chosen: [], other: '   ' }])).toContain('was left unanswered');
    });

    it('rejects "Other" text longer than the limit', () => {
        expect(validateAnswers([database], [{ chosen: [0], other: 'x'.repeat(501) }])).toContain('too long');
    });
});

describe('describeAnswers', () => {
    it("renders each question's header and the labels chosen", () => {
        expect(describeAnswers([database, features], [{ chosen: [0] }, { chosen: [0, 2] }])).toBe('Database: Postgres\nFeatures: Auth, Search');
    });

    it('includes "Other" text alongside any chosen labels', () => {
        expect(describeAnswers([database], [{ chosen: [0], other: 'and replicate it' }])).toBe('Database: Postgres, Other: and replicate it');
    });

    it('renders "Other" alone when nothing was chosen', () => {
        expect(describeAnswers([database], [{ chosen: [], other: 'MySQL' }])).toBe('Database: Other: MySQL');
    });
});
