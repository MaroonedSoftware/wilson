import { describe, expect, it } from 'vitest';
import { expectedFromAttempt, resolveAttempt, type AttemptEvent } from '#modules/evals/eval.attempt.js';

let nextId = 0;
const event = (type: string, stage: string, payload: Record<string, unknown> = {}): AttemptEvent => ({ id: String(++nextId), stage, type, payload });

describe('resolveAttempt', () => {
    it('starts a first implementing attempt from its own fork point, with no head of its own', () => {
        const dispatched = event('stage.dispatched', 'implementing');
        const log = [event('worktree.created', 'implementing', { baseSha: 'base1' }), dispatched];

        expect(resolveAttempt(log, 'implementing')).toEqual({ eventId: dispatched.id, baseSha: 'base1', headSha: 'base1' });
    });

    it('starts a later stage from the last commit, measured from that commit’s own fork point', () => {
        const log = [
            event('worktree.created', 'implementing', { baseSha: 'base1' }),
            event('stage.dispatched', 'implementing'),
            event('work.committed', 'implementing', { sha: 'impl1' }),
            event('stage.passed', 'implementing'),
            event('worktree.created', 'testing', { baseSha: 'base1' }),
            event('stage.dispatched', 'testing'),
        ];

        expect(resolveAttempt(log, 'testing')).toMatchObject({ baseSha: 'base1', headSha: 'impl1' });
    });

    it('does not pair a rebased fork point with a commit from before the rebase', () => {
        const log = [
            event('worktree.created', 'implementing', { baseSha: 'base1' }),
            event('stage.dispatched', 'implementing'),
            event('work.committed', 'implementing', { sha: 'impl1' }),
            event('stage.passed', 'implementing'),
            event('worktree.created', 'testing', { baseSha: 'rebased' }),
            event('stage.dispatched', 'testing'),
        ];

        expect(resolveAttempt(log, 'testing')).toMatchObject({ baseSha: 'base1', headSha: 'impl1' });
    });

    it('counts attempts from 1 and defaults to the latest', () => {
        const first = event('stage.dispatched', 'review');
        const second = event('stage.dispatched', 'review');
        const log = [
            event('worktree.created', 'implementing', { baseSha: 'base1' }),
            event('work.committed', 'implementing', { sha: 'impl1' }),
            first,
            event('stage.failed', 'review'),
            second,
            event('stage.passed', 'review'),
        ];

        expect(resolveAttempt(log, 'review', 1)?.eventId).toBe(first.id);
        expect(resolveAttempt(log, 'review', 2)?.eventId).toBe(second.id);
        expect(resolveAttempt(log, 'review')?.eventId).toBe(second.id);
        expect(resolveAttempt(log, 'review', 3)).toBeUndefined();
    });

    it('leaves out a step, which logs under its lane’s name', () => {
        const review = event('stage.dispatched', 'review');
        const log = [
            event('worktree.created', 'review', { baseSha: 'base1' }),
            review,
            event('stage.passed', 'review'),
            event('stage.dispatched', 'review'),
            event('stage.passed', 'review', { step: 'challenge' }),
        ];

        expect(resolveAttempt(log, 'review')?.eventId).toBe(review.id);
    });

    it('carries the plan version a newer dispatch recorded', () => {
        const log = [event('worktree.created', 'review', { baseSha: 'base1' }), event('stage.dispatched', 'review', { planVersionId: '42' })];

        expect(resolveAttempt(log, 'review')?.planVersionId).toBe('42');
    });

    it('answers nothing for a stage never attempted, or one with no fork point on record', () => {
        expect(resolveAttempt([event('worktree.created', 'review', { baseSha: 'base1' })], 'testing')).toBeUndefined();
        expect(resolveAttempt([event('stage.dispatched', 'review')], 'review')).toBeUndefined();
    });
});

describe('expectedFromAttempt', () => {
    const blocker = (file: string) => ({ severity: 'blocker', file });

    it('reads a pass off the attempt’s own result', () => {
        const dispatched = event('stage.dispatched', 'review');
        const log = [dispatched, event('stage.passed', 'review', { result: { verdict: 'pass', findings: [{ severity: 'concern', file: 'a.ts' }] } })];

        expect(expectedFromAttempt(log, dispatched.id)).toEqual({ verdict: 'pass', blockerFiles: [], source: 'attempt' });
    });

    it('names each blocker’s file once, leaving concerns out', () => {
        const dispatched = event('stage.dispatched', 'review');
        const findings = [blocker('a.ts'), blocker('a.ts'), blocker('b.ts'), { severity: 'concern', file: 'c.ts' }];
        const log = [dispatched, event('stage.passed', 'review', { result: { verdict: 'revise', findings } })];

        expect(expectedFromAttempt(log, dispatched.id)).toEqual({ verdict: 'revise', blockerFiles: ['a.ts', 'b.ts'], source: 'attempt' });
    });

    it('lets a challenge straight after have the last word', () => {
        const dispatched = event('stage.dispatched', 'review');
        const log = [
            dispatched,
            event('stage.passed', 'review', { result: { verdict: 'revise', findings: [blocker('a.ts')] } }),
            event('stage.dispatched', 'review'),
            event('stage.passed', 'review', { step: 'challenge', result: { verdict: 'pass', findings: [] } }),
        ];

        expect(expectedFromAttempt(log, dispatched.id)).toMatchObject({ verdict: 'pass', blockerFiles: [] });
    });

    it('does not read a later attempt’s result as this one’s', () => {
        const dispatched = event('stage.dispatched', 'review');
        const log = [
            dispatched,
            event('stage.passed', 'review', { result: { verdict: 'revise', findings: [blocker('a.ts')] } }),
            event('stage.passed', 'review', { result: { verdict: 'pass', findings: [] } }),
        ];

        expect(expectedFromAttempt(log, dispatched.id)).toMatchObject({ verdict: 'revise' });
    });

    it('answers nothing for an attempt with no coherent verdict, or no ending', () => {
        const dispatched = event('stage.dispatched', 'review');

        expect(expectedFromAttempt([dispatched, event('stage.failed', 'review', { result: null })], dispatched.id)).toBeUndefined();
        expect(expectedFromAttempt([dispatched], dispatched.id)).toBeUndefined();
    });
});
