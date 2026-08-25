import { describe, expect, it } from 'vitest';
import { kickback, shouldAdvance } from '#modules/stages/kickback.js';
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

describe('kickback', () => {
    it('increments the counter for the failing stage from an absent count', () => {
        const stage = makeStage();
        const decision = kickback(stage, {});

        expect(decision.retries).toEqual({ testing: 1 });
    });

    it('routes to onFail while the stage has failed fewer than maxKickbacks times', () => {
        const stage = makeStage({ maxKickbacks: 3, onFail: 'implementing' });

        const first = kickback(stage, {});
        expect(first.target).toBe('implementing');
        expect(first.retries.testing).toBe(1);

        const second = kickback(stage, first.retries);
        expect(second.target).toBe('implementing');
        expect(second.retries.testing).toBe(2);
    });

    it('stays on the stage’s own name and flags needsHuman on the maxKickbacks-th failure, not one beyond it', () => {
        const stage = makeStage({ maxKickbacks: 3, onFail: 'implementing' });

        const third = kickback(stage, { testing: 2 });

        expect(third.retries.testing).toBe(3);
        expect(third.target).toBe('testing');
        expect(third.needsHuman?.reason).toContain('testing');
        expect(third.needsHuman?.reason).toContain('3');
    });

    it('does not route to needs-human before maxKickbacks failures', () => {
        const stage = makeStage({ maxKickbacks: 3, onFail: 'implementing' });

        const second = kickback(stage, { testing: 1 });

        expect(second.retries.testing).toBe(2);
        expect(second.target).toBe('implementing');
    });

    it('keeps counters for other stages independent', () => {
        const stage = makeStage({ name: 'testing', maxKickbacks: 5 });
        const existing = { review: 2, testing: 1 };

        const decision = kickback(stage, existing);

        expect(decision.retries).toEqual({ review: 2, testing: 2 });
    });

    it('never mutates the caller-supplied retries object', () => {
        const stage = makeStage();
        const original = { testing: 1 };
        const originalCopy = { ...original };

        kickback(stage, original);

        expect(original).toEqual(originalCopy);
    });

    it('returns a new retries object rather than the same reference', () => {
        const stage = makeStage();
        const original = { testing: 1 };

        const decision = kickback(stage, original);

        expect(decision.retries).not.toBe(original);
    });

    it('gives up on the first failure when maxKickbacks is 1', () => {
        const stage = makeStage({ maxKickbacks: 1, onFail: 'implementing' });

        const decision = kickback(stage, {});

        expect(decision.retries.testing).toBe(1);
        expect(decision.target).toBe('testing');
        expect(decision.needsHuman).toBeDefined();
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
