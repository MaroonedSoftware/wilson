import { describe, expect, it } from 'vitest';
import { kickback, shouldAdvance } from '#modules/stages/kickback.js';
import type { StageConfig } from '#modules/stages/stage.config.js';
import { stageDefaults } from '#tests/modules/stages/stage.fixture.js';

const makeStage = (overrides: Partial<StageConfig> = {}): StageConfig => ({
    ...stageDefaults,
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

describe('kickback', () => {
    it('increments the counter for the failing stage from an absent count', () => {
        const stage = makeStage();
        const decision = kickback(stage, {}, false, false);

        expect(decision.retries).toEqual({ testing: 1 });
    });

    it('routes to onFail while the stage has failed fewer than maxKickbacks times', () => {
        const stage = makeStage({ maxKickbacks: 3, onFail: 'implementing' });

        const first = kickback(stage, {}, false, false);
        expect(first.target).toBe('implementing');
        expect(first.retries.testing).toBe(1);

        const second = kickback(stage, first.retries, false, false);
        expect(second.target).toBe('implementing');
        expect(second.retries.testing).toBe(2);
    });

    it('stays on the stage’s own name and flags needsHuman on the maxKickbacks-th failure, not one beyond it', () => {
        const stage = makeStage({ maxKickbacks: 3, onFail: 'implementing' });

        const third = kickback(stage, { testing: 2 }, false, false);

        expect(third.retries.testing).toBe(3);
        expect(third.target).toBe('testing');
        expect(third.needsHuman?.reason).toContain('testing');
        expect(third.needsHuman?.reason).toContain('3');
    });

    it('does not route to needs-human before maxKickbacks failures', () => {
        const stage = makeStage({ maxKickbacks: 3, onFail: 'implementing' });

        const second = kickback(stage, { testing: 1 }, false, false);

        expect(second.retries.testing).toBe(2);
        expect(second.target).toBe('implementing');
    });

    it('keeps counters for other stages independent', () => {
        const stage = makeStage({ name: 'testing', maxKickbacks: 5 });
        const existing = { review: 2, testing: 1 };

        const decision = kickback(stage, existing, false, false);

        expect(decision.retries).toEqual({ review: 2, testing: 2 });
    });

    it('never mutates the caller-supplied retries object', () => {
        const stage = makeStage();
        const original = { testing: 1 };
        const originalCopy = { ...original };

        kickback(stage, original, false, false);

        expect(original).toEqual(originalCopy);
    });

    it('returns a new retries object rather than the same reference', () => {
        const stage = makeStage();
        const original = { testing: 1 };

        const decision = kickback(stage, original, false, false);

        expect(decision.retries).not.toBe(original);
    });

    it('gives up on the first failure when maxKickbacks is 1', () => {
        const stage = makeStage({ maxKickbacks: 1, onFail: 'implementing' });

        const decision = kickback(stage, {}, false, false);

        expect(decision.retries.testing).toBe(1);
        expect(decision.target).toBe('testing');
        expect(decision.needsHuman).toBeDefined();
    });
});

// Card 0082: `kickback`'s third parameter carries what `stage.dispatcher.ts` learns from the run's
// own outcome — whether the failure was a judgment of the code, or the stage never finishing long
// enough to produce one. `onFail` still decides the target for a judged failure; `unjudged` overrides
// it, sending the retry back to the stage that failed instead of wherever `onFail` points.
describe('kickback — unjudged overrides onFail', () => {
    it('routes to the stage itself when unjudged is true, even though onFail points elsewhere', () => {
        const stage = makeStage({ name: 'review', onFail: 'implementing', maxKickbacks: 3 });

        const decision = kickback(stage, {}, true, false);

        expect(decision.target).toBe('review');
        expect(decision.retries.review).toBe(1);
        expect(decision.needsHuman).toBeUndefined();
    });

    it('still routes to onFail when unjudged is false, exactly as before this card', () => {
        const stage = makeStage({ name: 'review', onFail: 'implementing', maxKickbacks: 3 });

        const decision = kickback(stage, {}, false, false);

        expect(decision.target).toBe('implementing');
    });

    it('keeps counting and flags needsHuman at maxKickbacks for a self-routed unjudged failure, same as any other kickback', () => {
        const stage = makeStage({ name: 'review', onFail: 'implementing', maxKickbacks: 2 });

        const first = kickback(stage, {}, true, false);
        expect(first.target).toBe('review');
        expect(first.needsHuman).toBeUndefined();

        const second = kickback(stage, first.retries, true, false);
        expect(second.target).toBe('review');
        expect(second.retries.review).toBe(2);
        expect(second.needsHuman?.reason).toContain('review');
        expect(second.needsHuman?.reason).toContain('2');
    });

    it('makes no difference for a stage whose onFail already targets itself', () => {
        const stage = makeStage({ name: 'testing', onFail: 'testing', maxKickbacks: 3 });

        const judged = kickback(stage, {}, false, false);
        const unjudged = kickback(stage, {}, true, false);

        expect(judged.target).toBe('testing');
        expect(unjudged.target).toBe('testing');
    });
});

describe('shouldAdvance', () => {
    it('never advances a failed stage, no matter what the result carries', () => {
        expect(shouldAdvance(false, undefined)).toBe(false);
        expect(shouldAdvance(false, { verdict: 'pass' })).toBe(false);
    });

    it('advances a passing stage whose result carries no verdict at all', () => {
        expect(shouldAdvance(true, undefined)).toBe(true);
        expect(shouldAdvance(true, {})).toBe(true);
        expect(shouldAdvance(true, { summary: 'implemented the thing' })).toBe(true);
    });

    it('advances a passing review that passes', () => {
        expect(shouldAdvance(true, { verdict: 'pass' })).toBe(true);
    });

    it('does not advance a passing review that asks for revision', () => {
        // A `revise` verdict is a well-formed, passing review result — the review itself did what it
        // was asked. The card still must go backward, which is exactly the case a plain `passed` flag
        // cannot distinguish.
        expect(shouldAdvance(true, { verdict: 'revise' })).toBe(false);
    });

    it('treats a null result the same as an absent one', () => {
        expect(shouldAdvance(true, null)).toBe(true);
    });
});
