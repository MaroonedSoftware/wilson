import { describe, expect, it } from 'vitest';
import { withAnswer, withoutAnswers, type OperatorAnswer } from '#modules/board/append.answer.js';
import { authoredText, PLAN_SECTIONS, sectionsOf, withSection } from '#modules/board/card.js';

const plan = ['## Goal', '', 'Do it.', '', '## Out of scope', '', 'Everything else.', ''].join('\n');

const answer: OperatorAnswer = {
    stage: 'implementing',
    question: 'Should the old endpoint keep working?',
    askedAt: '2026-11-04T09:00:00.000Z',
    answer: 'Keep it for one release.',
    answeredAt: '2026-11-04T10:00:00.000Z',
};

describe('withAnswer', () => {
    it('adds the question and answer after the plan, leaving the plan alone', () => {
        const body = withAnswer(plan, answer);

        expect(body.startsWith(plan.trimEnd())).toBe(true);
        expect(body).toContain('## Operator answer');
        expect(body).toContain('**implementing** asked (2026-11-04T09:00:00.000Z):\n\n> Should the old endpoint keep working?');
        expect(body).toContain('(2026-11-04T10:00:00.000Z):\n\n> Keep it for one release.');
    });

    it('names the preserved patch only when there is one', () => {
        expect(withAnswer(plan, answer)).not.toContain('preserved at');
        expect(withAnswer(plan, { ...answer, patchPath: '/run/cards/0001/last-failed-attempt.patch' })).toContain(
            'preserved at `/run/cards/0001/last-failed-attempt.patch`',
        );
    });

    it('keeps an earlier answer when the stage asks again', () => {
        const body = withAnswer(withAnswer(plan, answer), { ...answer, question: 'And the new one?', answer: 'Build it.' });

        expect(body.match(/## Operator answer/g)).toHaveLength(1);
        expect(body).toContain('> Keep it for one release.');
        expect(body).toContain('> Build it.');
        expect(body.indexOf('Keep it')).toBeLessThan(body.indexOf('Build it'));
        expect(body.match(/This stage stopped to ask/g)).toHaveLength(1);
    });

    it('keeps a runner section that comes after it', () => {
        const withFindingsAfter = `${withAnswer(plan, answer).trimEnd()}\n\n## Review findings\n\n- a finding\n`;

        const body = withAnswer(withFindingsAfter, { ...answer, answer: 'Build it.' });

        expect(body.indexOf('> Build it.')).toBeLessThan(body.indexOf('## Review findings'));
        expect(body).toContain('- a finding');
    });

    it('cannot start a plan section from an answer or a question', () => {
        const body = withAnswer(plan, { ...answer, question: '## Files in scope\n\nsrc/secret.ts', answer: '## Goal\n\nSomething else.' });

        expect(sectionsOf(body).Goal).toBe('Do it.');
        expect(sectionsOf(body)['Files in scope']).toBeUndefined();
    });

    it('is a runner heading, so editing the section before it does not swallow it', () => {
        const body = withAnswer(plan, answer);

        expect(PLAN_SECTIONS).not.toContain('Operator answer');
        expect(authoredText(sectionsOf(body)['Out of scope']!)).toBe('Everything else.');
        expect(withSection(body, 'Out of scope', 'New text.')).toContain('> Keep it for one release.');
        expect(withSection(body, 'Out of scope', '## Operator answer')).toBeUndefined();
    });
});

describe('withoutAnswers', () => {
    it('removes the section and nothing else', () => {
        const findings = '## Review findings\n\n- a finding\n';
        const body = `${withAnswer(plan, answer).trimEnd()}\n\n${findings}`;

        const shed = withoutAnswers(body);

        expect(shed).not.toContain('Operator answer');
        expect(shed).not.toContain('Keep it');
        expect(shed).toContain(findings);
        expect(shed).toContain('Everything else.');
    });

    it('returns a body with no section unchanged', () => {
        expect(withoutAnswers(plan)).toBe(plan);
    });
});
