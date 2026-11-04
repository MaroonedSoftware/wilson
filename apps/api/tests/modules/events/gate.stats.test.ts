import { describe, expect, it } from 'vitest';
import { contextBudgetExceeded, engineSilent, overBudget, stepsExceeded, wallClockExceeded } from '#modules/agent/budget.js';
import { foldGateStats, matchOlderFailure, type GateEventRow } from '#modules/events/gate.stats.js';

const row = (type: string, fields: Partial<GateEventRow> = {}): GateEventRow => ({
    cardId: '0001',
    stage: 'review',
    type,
    step: null,
    verdict: null,
    failureClass: null,
    error: null,
    firstFailure: null,
    loopStopped: null,
    alreadyResolved: null,
    from: null,
    to: null,
    by: null,
    needsHuman: null,
    reason: null,
    retries: null,
    ...fields,
});

const transition = (fields: Partial<GateEventRow> = {}) => row('transition.written', { by: 'runner', from: 'review', to: 'implementing', ...fields });

describe('matchOlderFailure', () => {
    it.each([
        [overBudget(10, 5), 'budget'],
        [contextBudgetExceeded(0.5, 60), 'budget'],
        [wallClockExceeded(1000), 'budget'],
        [stepsExceeded(60, 0), 'budget'],
        ['the stage used all 60 of its steps and was cut off mid-run', 'budget'],
        [engineSilent(1000), 'engine'],
        ['the engine failed: boom', 'engine'],
        ['the stage called report_result and the result did not arrive, so the runner never saw it', 'resultDropped'],
        ['the stage ended without calling report_result, so it never reported finishing', 'noReport'],
        ['the diff is empty', 'verifier'],
        [null, 'verifier'],
    ])('reads %s as %s', (text, expected) => {
        expect(matchOlderFailure(text as string | null)).toBe(expected);
    });
});

describe('foldGateStats kickbacks', () => {
    it('counts a lane revise with no step waiting as a kickback, and how many passes were a revise', () => {
        const figures = foldGateStats([row('stage.passed', { verdict: 'revise' }), transition()]);

        expect(figures.kickbacks).toEqual([{ stage: 'review', reason: 'revise', count: 1, matched: 0 }]);
        expect(figures.revised).toEqual([{ stage: 'review', count: 1 }]);
    });

    it('holds a revise a challenge is about to test, then counts only what the challenge upholds', () => {
        const figures = foldGateStats([
            row('stage.passed', { verdict: 'revise' }),
            transition({ to: 'review', step: 'challenge' }),
            row('stage.passed', { step: 'challenge', verdict: 'revise' }),
            transition(),
            row('stage.passed', { cardId: '0002', verdict: 'revise' }),
            transition({ cardId: '0002', to: 'review', step: 'challenge' }),
            row('stage.passed', { cardId: '0002', step: 'challenge', verdict: 'pass' }),
            transition({ cardId: '0002', to: 'testing' }),
        ]);

        expect(figures.kickbacks).toEqual([{ stage: 'review', step: 'challenge', reason: 'revise', count: 1, matched: 0 }]);
        expect(figures.challenge).toEqual({ upheld: 1, overturned: 1 });
        expect(figures.revised).toEqual([{ stage: 'review', count: 3 }]);
    });

    it('counts a verifier failure as a kickback and a retried cutoff as a failure only', () => {
        const figures = foldGateStats([
            row('stage.failed', { stage: 'testing', failureClass: 'verifier' }),
            row('stage.failed', { stage: 'testing', failureClass: 'budget' }),
        ]);

        expect(figures.kickbacks).toEqual([{ stage: 'testing', reason: 'verifier', count: 1, matched: 0 }]);
        expect(figures.failures).toEqual(
            expect.arrayContaining([
                { failureClass: 'verifier', count: 1, matched: 0 },
                { failureClass: 'budget', count: 1, matched: 0 },
            ]),
        );
        expect(figures.matched).toBe(0);
    });

    it('labels an older failure as matched, but not one its own fields already explain', () => {
        const figures = foldGateStats([
            row('stage.failed', { firstFailure: wallClockExceeded(1000) }),
            row('stage.failed', { firstFailure: 'the diff is empty' }),
            row('stage.failed', { firstFailure: 'made the same call', loopStopped: true }),
            row('stage.failed', { error: 'it threw' }),
        ]);

        expect(figures.matched).toBe(2);
        expect(figures.loopStops).toBe(1);
        expect(figures.failures).toEqual(
            expect.arrayContaining([
                { failureClass: 'budget', count: 1, matched: 1 },
                { failureClass: 'verifier', count: 1, matched: 1 },
                { failureClass: 'loop', count: 1, matched: 0 },
                { failureClass: 'error', count: 1, matched: 0 },
            ]),
        );
        expect(figures.kickbacks).toEqual([{ stage: 'review', reason: 'verifier', count: 1, matched: 1 }]);
    });
});

describe('foldGateStats touchpoints', () => {
    const flag = (fields: Partial<GateEventRow> = {}) => transition({ to: 'review', needsHuman: true, ...fields });

    it('counts each cause and its flag as one', () => {
        const figures = foldGateStats([
            row('card.over-budget'),
            flag(),
            row('context.overflow', { cardId: '0002' }),
            flag({ cardId: '0002' }),
            row('rebase.conflict', { cardId: '0003' }),
            flag({ cardId: '0003' }),
            row('stage.blocked', { cardId: '0004' }),
            flag({ cardId: '0004' }),
            flag({ cardId: '0005' }),
            flag({ cardId: '0006', reason: 'source-closed' }),
        ]);

        expect(figures.touchpoints).toEqual(
            expect.arrayContaining([
                { cause: 'overBudget', count: 1 },
                { cause: 'contextOverflow', count: 1 },
                { cause: 'rebaseConflict', count: 1 },
                { cause: 'question', count: 1 },
                { cause: 'kickbackLimit', count: 1 },
                { cause: 'sourceClosed', count: 1 },
            ]),
        );
        expect(figures.touchpoints).toHaveLength(6);
        expect(figures.questions.asked).toBe(1);
    });

    it('names a death rather than the poisoning it caused, and ignores one already resolved', () => {
        const figures = foldGateStats([
            row('stage.dead'),
            row('stage.poisoned'),
            transition({ to: 'poisoned' }),
            row('stage.poisoned', { cardId: '0002' }),
            transition({ cardId: '0002', to: 'poisoned' }),
            row('stage.dead', { cardId: '0003', alreadyResolved: true }),
        ]);

        expect(figures.touchpoints).toEqual(
            expect.arrayContaining([
                { cause: 'dead', count: 1 },
                { cause: 'poisoned', count: 1 },
            ]),
        );
        expect(figures.touchpoints).toHaveLength(2);
    });

    it('does not count a flag on a flagged card again until something clears it', () => {
        const figures = foldGateStats([
            row('card.over-budget'),
            flag(),
            row('card.over-budget'),
            flag(),
            row('card.acked'),
            row('stage.blocked'),
            flag(),
            row('card.answered'),
            row('stage.blocked'),
            flag(),
            transition({ by: 'human', to: 'testing' }),
            flag(),
        ]);

        expect(figures.touchpoints).toEqual(
            expect.arrayContaining([
                { cause: 'overBudget', count: 1 },
                { cause: 'question', count: 2 },
                { cause: 'kickbackLimit', count: 1 },
            ]),
        );
        expect(figures.questions).toEqual({ asked: 2, answered: 1 });
    });

    it('leaves out a flag a person raised themselves', () => {
        expect(foldGateStats([flag({ by: 'human' })]).touchpoints).toEqual([]);
    });
});

describe('foldGateStats firstPass', () => {
    it('counts a card once, ignoring free counters but not a retry an ack has since cleared', () => {
        const figures = foldGateStats([
            transition({ cardId: 'clean', to: 'ready', retries: { 'review:resultDropped': 2, 'review:blocked': 1, 'review:re-review': 1 } }),
            transition({ cardId: 'clean', to: 'merged' }),
            transition({ cardId: 'retried', to: 'ready', retries: { review: 1 } }),
            row('card.acked', { cardId: 'acked', retries: 3 }),
            transition({ cardId: 'acked', to: 'ready', retries: {} }),
            transition({ cardId: 'unfinished', to: 'testing', retries: {} }),
        ]);

        expect(figures.firstPass).toEqual({ reached: 3, firstPass: 1 });
    });
});
