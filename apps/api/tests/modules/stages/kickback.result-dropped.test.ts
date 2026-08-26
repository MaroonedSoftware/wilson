import { describe, expect, it } from 'vitest';
import { kickback } from '#modules/stages/kickback.js';
import type { StageConfig } from '#modules/stages/stage.config.js';

const makeStage = (overrides: Partial<StageConfig> = {}): StageConfig => ({
    name: 'testing',
    mode: 'agent',
    worktree: 'rw',
    provider: 'anthropic',
    model: 'claude-opus',
    instructions: 'test the thing',
    allowedCommands: [],
    worktreeFrom: 'branch',
    extraScope: [],
    baselineCheck: true,
    maxSteps: 60,
    maxOutputTokens: 16000,
    onPass: 'review',
    onFail: 'implementing',
    maxKickbacks: 3,
    ...overrides,
});

/**
 * Card 0092. `kickback`'s fourth parameter, `resultDropped`, is the accounting half of the card:
 * `unjudged` already routes a dropped-result failure back to the stage itself (that part is card
 * 0082's and does not change — see kickback.test.ts's own `unjudged` suite). What this suite covers
 * is that a dropped result gets a small free allowance before it starts spending
 * `retries[stage.name]` the way a genuine failure does, and that the allowance does not turn into an
 * infinite free retry loop — `RESULT_DROPPED_ALLOWANCE` in kickback.ts is documented at 2.
 */
describe('kickback — resultDropped spends nothing, up to a bound (card 0092)', () => {
    it('does not touch the stage’s own retry count on the first dropped-result failure', () => {
        const stage = makeStage({ maxKickbacks: 3 });

        const decision = kickback(stage, {}, true, true);

        expect(decision.target).toBe('testing');
        expect(decision.retries.testing).toBeUndefined();
        expect(decision.needsHuman).toBeUndefined();
    });

    it('keeps the free retry going for a second consecutive dropped result', () => {
        const stage = makeStage({ maxKickbacks: 3 });

        const first = kickback(stage, {}, true, true);
        const second = kickback(stage, first.retries, true, true);

        expect(second.target).toBe('testing');
        expect(second.retries.testing).toBeUndefined();
        expect(second.needsHuman).toBeUndefined();
    });

    it('never mutates the caller-supplied retries object for a dropped-result failure either', () => {
        const stage = makeStage();
        const original = { testing: 1 };
        const originalCopy = { ...original };

        kickback(stage, original, true, true);

        expect(original).toEqual(originalCopy);
    });

    it('starts charging retries[stage.name] like an ordinary failure once the free allowance is spent', () => {
        const stage = makeStage({ maxKickbacks: 5 });

        // Spend the free allowance (RESULT_DROPPED_ALLOWANCE = 2 in kickback.ts).
        const first = kickback(stage, {}, true, true);
        const second = kickback(stage, first.retries, true, true);
        expect(second.retries.testing).toBeUndefined();

        // The allowance is now spent: this dropped result is charged like any other failure.
        const third = kickback(stage, second.retries, true, true);

        expect(third.retries.testing).toBe(1);
        expect(third.target).toBe('testing');
        expect(third.needsHuman).toBeUndefined();
    });

    it('once the allowance is spent, an unjudged dropped result still self-routes rather than going to onFail', () => {
        const stage = makeStage({ onFail: 'implementing', maxKickbacks: 5 });

        let retries = kickback(stage, {}, true, true).retries;
        retries = kickback(stage, retries, true, true).retries;
        const decision = kickback(stage, retries, true, true);

        expect(decision.target).toBe('testing');
    });

    it('once the allowance is spent, a judged dropped result routes to onFail like any other judged failure', () => {
        // Not a shape the dispatcher actually produces (resultDropped implies unjudged), but kickback
        // is a pure function of its arguments and the fallthrough after the allowance is spent must
        // not hard-code unjudged behaviour independent of what the caller actually passed.
        const stage = makeStage({ onFail: 'implementing', maxKickbacks: 5 });

        let retries = kickback(stage, {}, false, true).retries;
        retries = kickback(stage, retries, false, true).retries;
        const decision = kickback(stage, retries, false, true);

        expect(decision.target).toBe('implementing');
        expect(decision.retries.testing).toBe(1);
    });

    it('reaches needsHuman for a stage that drops its result on every single attempt, rather than retrying forever for free', () => {
        const stage = makeStage({ maxKickbacks: 2, onFail: 'implementing' });

        // Two free attempts...
        let decision = kickback(stage, {}, true, true);
        expect(decision.needsHuman).toBeUndefined();
        decision = kickback(stage, decision.retries, true, true);
        expect(decision.needsHuman).toBeUndefined();
        expect(decision.retries.testing).toBeUndefined();

        // ...then the ordinary maxKickbacks budget (2) is spent by two more dropped-result attempts.
        decision = kickback(stage, decision.retries, true, true);
        expect(decision.retries.testing).toBe(1);
        expect(decision.needsHuman).toBeUndefined();

        decision = kickback(stage, decision.retries, true, true);
        expect(decision.retries.testing).toBe(2);
        expect(decision.target).toBe('testing');
        expect(decision.needsHuman?.reason).toContain('testing');
    });

    it('tracks the dropped-result count under its own key, separate from the stage’s ordinary retry count', () => {
        const stage = makeStage({ maxKickbacks: 5 });

        const decision = kickback(stage, { testing: 4 }, true, true);

        // The stage's own count (already at 4 from unrelated ordinary failures) is untouched...
        expect(decision.retries.testing).toBe(4);
        // ...while the dropped-result count is tracked separately and starts from zero.
        expect(decision.retries['testing:resultDropped']).toBe(1);
    });

    it('keeps a second stage’s dropped-result allowance independent of the first', () => {
        const testing = makeStage({ name: 'testing', maxKickbacks: 3 });
        const review = makeStage({ name: 'review', maxKickbacks: 3 });

        const afterTesting = kickback(testing, {}, true, true);
        const afterReview = kickback(review, afterTesting.retries, true, true);

        expect(afterReview.retries['testing:resultDropped']).toBe(1);
        expect(afterReview.retries['review:resultDropped']).toBe(1);
        expect(afterReview.retries.testing).toBeUndefined();
        expect(afterReview.retries.review).toBeUndefined();
    });
});
