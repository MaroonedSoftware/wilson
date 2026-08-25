import { describe, expect, it } from 'vitest';
import { kickback } from '#modules/stages/kickback.js';
import type { StageConfig } from '#modules/stages/stage.config.js';

/**
 * Card 0062. Card 0060's actual sequence, reproduced with the config that caused it:
 *
 *   implementing  PASSED — committed, all files the card asked for
 *   testing       FAILED — wrote no tests
 *   implementing  FAILED — "the diff is empty: the stage changed nothing"
 *   implementing  FAILED — "the diff is empty: the stage changed nothing"
 *                 retries exhausted
 *
 * `testing.onFail: implementing` sent a testing failure to a stage with nothing left to do.
 * `kickback` itself was never the bug — it is generic over whatever `onFail` names, including
 * itself — so the fix these tests pin down lives entirely in the config value each stage carries,
 * not in this function's logic. These tests exist to prove the *recommended* value actually breaks
 * 0060's cycle, and that it does so without touching the one case that must stay exactly as it is:
 * `review.onFail: implementing`.
 */
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

describe('kickback — reproducing card 0060 with the config that caused it', () => {
    it('with today’s testing.onFail: implementing, one testing failure hands implementing a card it exhausts retries on with nothing to fix', () => {
        // This is 0060's own config. It is not what this card recommends keeping — it is the shape
        // being fixed, pinned down so the next test can show the difference the fix makes.
        //
        // Two stages are involved, exactly as in the log: testing fails once and kicks back to
        // implementing (a *single* call against testing's own counter); implementing is then
        // re-dispatched with an already-committed, unchanged tree, reports an empty diff, and —
        // because implementing.onFail is itself — kicks back to itself against its *own* counter
        // until that exhausts too.
        const testingStage = makeStage({ name: 'testing', onFail: 'implementing', maxKickbacks: 3 });
        const testingKickback = kickback(testingStage, {});
        expect(testingKickback.target).toBe('implementing');
        expect(testingKickback.needsHuman).toBeUndefined();

        const implementingStage = makeStage({ name: 'implementing', onPass: 'testing', onFail: 'implementing', maxKickbacks: 2 });
        const firstEmptyDiff = kickback(implementingStage, {});
        expect(firstEmptyDiff.target).toBe('implementing');
        expect(firstEmptyDiff.needsHuman).toBeUndefined();

        // Second consecutive empty-diff failure on implementing's own counter reaches maxKickbacks:
        // the card is flagged for a human, stranded on implementing, having never had anything to
        // fix — card 0060's actual ending.
        const secondEmptyDiff = kickback(implementingStage, firstEmptyDiff.retries);
        expect(secondEmptyDiff.target).toBe('implementing');
        expect(secondEmptyDiff.needsHuman).toBeDefined();
    });

    it('with the recommended testing.onFail: testing, a testing failure never reaches implementing at all', () => {
        const testingStage = makeStage({ name: 'testing', onFail: 'testing', maxKickbacks: 3 });

        const first = kickback(testingStage, {});
        expect(first.target).toBe('testing');
        expect(first.target).not.toBe('implementing');

        const second = kickback(testingStage, first.retries);
        expect(second.target).toBe('testing');
        expect(second.target).not.toBe('implementing');

        // maxKickbacks-th failure: the card stays on testing and is flagged for a human, rather
        // than ever having been routed to implementing — the exact waste card 0060 spent all its
        // retries on. implementing's own counter is never touched, because kickback is never even
        // called against it.
        const third = kickback(testingStage, second.retries);
        expect(third.target).toBe('testing');
        expect(third.target).not.toBe('implementing');
        expect(third.needsHuman?.reason).toContain('testing');
        expect(third.retries).toEqual({ testing: 3 });
    });

    it('leaves review.onFail: implementing exactly as it is — a review blocker is still routed to the code', () => {
        // The plan is explicit that this is the case the fix must not touch: a review blocker is a
        // statement about the code, so implementing is still the right target when review fails.
        const reviewStage = makeStage({ name: 'review', onPass: 'ready', onFail: 'implementing', maxKickbacks: 3 });

        const first = kickback(reviewStage, {});
        expect(first.target).toBe('implementing');

        const second = kickback(reviewStage, first.retries);
        expect(second.target).toBe('implementing');
    });
});
